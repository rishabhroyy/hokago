import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
// Imported for the type augmentation (@fastify/websocket augments fastify's
// route shorthands with `websocket: true`) as much as for the plugin itself —
// without the import in the program, presence/party WS routes lose their types.
import websocketPlugin from "@fastify/websocket";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@hokago/contract/health";
import { probeConfigDir } from "@hokago/scanner/artwork";
import { killTrackedChildren, trackedPidCount } from "@hokago/ffmpeg/child-registry";
import { PrismaClient } from "@hokago/db";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAdminMgmtRoutes } from "./admin-mgmt-routes.js";
import { registerPlaybackRoutes } from "./playback-routes.js";
import { registerStaticRoutes } from "./static-routes.js";
import { registerAuth } from "./auth.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerSetupRoutes } from "./setup-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerAvatarRoutes } from "./avatar-routes.js";
import { registerBrowseRoutes } from "./browse-routes.js";
import { registerHomeRoutes } from "./home-routes.js";
import { registerWatchStateRoutes } from "./watch-state-routes.js";
import { registerWatchPartyRoutes, reapStalePartyMembers } from "./watch-party-routes.js";
import { registerWebRoutes } from "./web-routes.js";
import { registerPresence } from "./presence.js";
import { registerDownloadRoutes, closeDownloadQueue } from "./download-routes.js";
import { registerMetadataRoutes } from "./metadata-routes.js";
import { reapStaleSessions, killOrphanedTranscodes, cleanOrphanedTranscodeDirs } from "./playback-routes.js";
import { seedVendoredFonts } from "./font-seed.js";

// trustProxy is opt-in (HOKAGO_TRUST_PROXY): req.ip then honors
// X-Forwarded-For so rate limiting / logging see the real client behind a
// reverse proxy (nginx/caddy). Accepted forms: "true" (trust every hop —
// leftmost XFF entry), a hop count ("1"/"2" — trust that many proxied hops),
// or a comma-separated list of trusted proxy IPs. Cloudflare's
// CF-Connecting-IP is always honored by the clientIp helper regardless —
// see rate-limit.ts.
function trustProxySetting(): boolean | number | string[] {
  const raw = process.env.HOKAGO_TRUST_PROXY;
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Runtime image version, baked at build time (infra/docker/Dockerfile
// HOKAGO_VERSION ARG → ENV; CI injects the git tag). Host-side dev runs
// (vite dev server, CLI scripts) see "dev" — the containers always report
// what tag they run. /health is unauthenticated on purpose: native clients
// probe it to decide feature compatibility, like immich's /api/server/version.
const HOKAGO_VERSION = process.env.HOKAGO_VERSION || "dev";

const app = Fastify({
  logger: true,
  trustProxy: trustProxySetting(),
}).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
// Avatar uploads are raw image bytes, not JSON — parse them into a Buffer.
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});
// serve:false — no fixed root; static-routes.ts passes a per-file rootPath to
// reply.sendFile() since media/font/artwork paths live wherever the operator's
// library roots are, not under one shared static directory.
await app.register(fastifyStatic, { serve: false });
// The WS layer (presence + party sockets). Registered once at the root —
// @fastify/websocket is a fastify-plugin, a second registration throws.
await app.register(websocketPlugin);

app.get("/health", { schema: { response: { 200: HealthResponse } } }, async () => ({
  status: "ok" as const,
  version: HOKAGO_VERSION,
}));

// Config-dir probe: artwork/fonts/avatars/downloads live under
// HOKAGO_CONFIG_DIR (/config in compose). Missing env or mount = silent
// overlay fallback and every derived artifact 404s while playback still
// works — log loudly at boot instead of shipping a broken box.
const cfg = probeConfigDir();
if (!cfg.ok) {
  app.log.warn(
    { dir: cfg.dir, error: cfg.reason },
    "config dir unusable — artwork, fonts, avatars and downloads will 404 while playback keeps working. Set HOKAGO_CONFIG_DIR to the bind-mounted config dir (compose default: /config).",
  );
} else if (!cfg.explicit) {
  app.log.warn({ dir: cfg.dir }, "config dir is the cwd-derived default (HOKAGO_CONFIG_DIR unset) — run under compose with /config");
} else {
  app.log.info({ dir: cfg.dir }, "config dir");
}

const db = new PrismaClient();
await seedVendoredFonts(db);

await registerAuth(app);
await registerPresence(app);
await registerAdminRoutes(app);
await registerAdminMgmtRoutes(app);
await registerAuthRoutes(app);
await registerSetupRoutes(app);
await registerProfileRoutes(app);
await registerAvatarRoutes(app);
await registerBrowseRoutes(app);
await registerHomeRoutes(app);
await registerPlaybackRoutes(app);
await registerWatchStateRoutes(app);
await registerWatchPartyRoutes(app);
await registerMetadataRoutes(app);
await registerDownloadRoutes(app);
await registerStaticRoutes(app);
// Last: the SPA catch-all — everything the API doesn't own is the web app.
await registerWebRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Boot sweep: close sessions abandoned by a previous API run (restart, crash)
// immediately instead of waiting for the first 60s tick — otherwise the
// dashboard's "watching now" counts zombies for up to 5 minutes after boot.
reapStaleSessions()
  .then((reaped) => {
    if (reaped > 0) app.log.info(`boot sweep: reaped ${reaped} stale playback session(s)`);
  })
  .catch((err) => app.log.error({ err }, "boot sweep failed"));

// Kills ffmpeg children orphaned by a previous API process — a dev restart or
// crash leaves the recorded pids alive and transcoding until EOF. Without
// this, every API restart leaks up to HOKAGO_MAX_TRANSCODES processes.
killOrphanedTranscodes()
  .then((killed) => {
    if (killed > 0) app.log.info(`boot sweep: killed ${killed} orphaned ffmpeg process(es)`);
  })
  .catch((err) => app.log.error({ err }, "orphan ffmpeg sweep failed"));

// Transcode directories are session-lifetime scratch (GBs of segments per
// title) and sessions are tracked in memory — every dir left behind by a
// previous API process is garbage. Wipe them at boot, same reasoning as the
// orphan ffmpeg sweep above.
cleanOrphanedTranscodeDirs()
  .then((removed) => {
    if (removed > 0) app.log.info(`boot sweep: removed ${removed} orphaned transcode directorie(s)`);
  })
  .catch((err) => app.log.error({ err }, "transcode dir sweep failed"));

// Reaps any live transcode children on shutdown — apps/api owns them directly
// (separate PID namespace from apps/worker), so nothing else can reap them.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal}: closing (tracked ffmpeg children: ${trackedPidCount()})...`);
  killTrackedChildren("SIGKILL");
  await closeDownloadQueue();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Idle reaper: closes playback sessions whose client stopped heartbeating
// (closed tab, crashed player) — kills their ffmpeg child and frees the
// transcode slot, so abandoned playback can't accumulate processes. The same
// sweep drops stale watch-party members and old ended parties.
setInterval(() => {
  reapStaleSessions()
    .then((reaped) => {
      if (reaped > 0) app.log.info(`reaped ${reaped} stale playback session(s)`);
    })
    .catch((err) => app.log.error({ err }, "stale session reap failed"));
  reapStalePartyMembers()
    .then((reaped) => {
      if (reaped > 0) app.log.info(`reaped ${reaped} stale watch-party member(s)/party(ies)`);
    })
    .catch((err) => app.log.error({ err }, "stale party reap failed"));
}, 60_000);
