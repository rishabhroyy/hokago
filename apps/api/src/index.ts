import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@hokago/contract/health";
import { killTrackedChildren, trackedPidCount } from "@hokago/ffmpeg/child-registry";
import { PrismaClient } from "@hokago/db";
import { referenceThemes } from "@hokago/theme";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerPlaybackRoutes } from "./playback-routes.js";
import { registerStaticRoutes } from "./static-routes.js";
import { registerAuth } from "./auth.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerBrowseRoutes } from "./browse-routes.js";
import { registerWatchStateRoutes } from "./watch-state-routes.js";
import { registerPresence } from "./presence.js";
import { registerThemeRoutes } from "./theme-routes.js";
import { seedVendoredFonts } from "./font-seed.js";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.get("/health", { schema: { response: { 200: HealthResponse } } }, async () => ({
  status: "ok" as const,
  version: "0.0.0",
}));

// Boot reconciler, same spirit as §9.6's job reconciler: every bundled
// reference theme (§15.3) must exist as a real Theme row for any Profile to
// reference, on every boot, idempotently — not a one-off manual seed step an
// operator can forget.
const db = new PrismaClient();
for (const theme of referenceThemes) {
  await db.theme.upsert({
    where: { slug: theme.slug },
    create: {
      slug: theme.slug,
      name: theme.name,
      source: "BUILTIN",
      colorScheme: theme.colorScheme.toUpperCase() as "DARK" | "LIGHT",
      tokens: theme.tokens,
    },
    update: { tokens: theme.tokens, colorScheme: theme.colorScheme.toUpperCase() as "DARK" | "LIGHT" },
  });
}
await seedVendoredFonts(db, referenceThemes);

await registerAuth(app);
await registerPresence(app);
await registerAdminRoutes(app);
await registerAuthRoutes(app);
await registerProfileRoutes(app);
await registerBrowseRoutes(app);
await registerThemeRoutes(app);
await registerPlaybackRoutes(app);
await registerWatchStateRoutes(app);
await registerStaticRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Reaps any live transcode children on shutdown — apps/api owns them directly
// (separate PID namespace from apps/worker), so nothing else can reap them (§9.6.4).
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
