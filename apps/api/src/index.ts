import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@hokago/contract/health";
import { killTrackedChildren, trackedPidCount } from "@hokago/ffmpeg/child-registry";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerPlaybackRoutes } from "./playback-routes.js";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.get("/health", { schema: { response: { 200: HealthResponse } } }, async () => ({
  status: "ok" as const,
  version: "0.0.0",
}));

await registerAdminRoutes(app);
await registerPlaybackRoutes(app);

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
