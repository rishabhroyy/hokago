import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@hokago/contract/health";
import { killTrackedChildren, trackedPidCount } from "@hokago/ffmpeg/child-registry";
import { PrismaClient } from "@hokago/db";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAdminMgmtRoutes } from "./admin-mgmt-routes.js";
import { registerPlaybackRoutes } from "./playback-routes.js";
import { registerStaticRoutes } from "./static-routes.js";
import { registerAuth } from "./auth.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerAvatarRoutes } from "./avatar-routes.js";
import { registerBrowseRoutes } from "./browse-routes.js";
import { registerWatchStateRoutes } from "./watch-state-routes.js";
import { registerWebRoutes } from "./web-routes.js";
import { registerPresence } from "./presence.js";
import { reapStaleSessions, killOrphanedTranscodes, cleanOrphanedTranscodeDirs } from "./playback-routes.js";
import { seedVendoredFonts } from "./font-seed.js";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
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

app.get("/health", { schema: { response: { 200: HealthResponse } } }, async () => ({
  status: "ok" as const,
  version: "0.0.0",
}));

const db = new PrismaClient();
await seedVendoredFonts(db);

await registerAuth(app);
await registerPresence(app);
await registerAdminRoutes(app);
await registerAdminMgmtRoutes(app);
await registerAuthRoutes(app);
await registerProfileRoutes(app);
await registerAvatarRoutes(app);
await registerBrowseRoutes(app);
await registerPlaybackRoutes(app);
await registerWatchStateRoutes(app);
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
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Idle reaper: closes playback sessions whose client stopped heartbeating
// (closed tab, crashed player) — kills their ffmpeg child and frees the
// transcode slot, so abandoned playback can't accumulate processes.
setInterval(() => {
  reapStaleSessions()
    .then((reaped) => {
      if (reaped > 0) app.log.info(`reaped ${reaped} stale playback session(s)`);
    })
    .catch((err) => app.log.error({ err }, "stale session reap failed"));
}, 60_000);
