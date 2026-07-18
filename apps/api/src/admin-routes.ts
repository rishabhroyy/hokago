import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { Queue, getConnection, QUEUE_NAMES, type QueueName } from "@hokago/queue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connection = getConnection();
const queues: Record<QueueName, Queue> = {
  scan: new Queue(QUEUE_NAMES.SCAN, { connection }),
  artwork: new Queue(QUEUE_NAMES.ARTWORK, { connection }),
  "metadata-tvmaze": new Queue(QUEUE_NAMES.METADATA_TVMAZE, { connection }),
  "metadata-anilist": new Queue(QUEUE_NAMES.METADATA_ANILIST, { connection }),
  "metadata-mal": new Queue(QUEUE_NAMES.METADATA_MAL, { connection }),
};

const JOB_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;
type JobState = (typeof JOB_STATES)[number];

function queueOrNotFound(name: string): Queue | null {
  return name in queues ? queues[name as QueueName] : null;
}

/** Admin queue UI (§9.6.8): view/pause/resume/retry-failed/clean per queue, backed directly by BullMQ. */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin", async (_req, reply) => {
    const html = await readFile(path.join(__dirname, "admin.html"), "utf-8");
    reply.type("text/html").send(html);
  });

  app.get("/admin/queues", async () => {
    const result = await Promise.all(
      Object.entries(queues).map(async ([name, queue]) => ({
        name,
        paused: await queue.isPaused(),
        counts: await queue.getJobCounts(...JOB_STATES),
      })),
    );
    return result;
  });

  app.get<{ Params: { name: string }; Querystring: { state?: string } }>(
    "/admin/queues/:name/jobs",
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      const state = (req.query.state as JobState) ?? "failed";
      if (!JOB_STATES.includes(state)) return reply.code(400).send({ error: "invalid state" });

      const jobs = await queue.getJobs([state], 0, 100);
      return jobs.map((job) => ({
        id: job.id,
        data: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
      }));
    },
  );

  app.post<{ Params: { name: string } }>("/admin/queues/:name/pause", async (req, reply) => {
    const queue = queueOrNotFound(req.params.name);
    if (!queue) return reply.code(404).send({ error: "unknown queue" });
    await queue.pause();
    return { paused: true };
  });

  app.post<{ Params: { name: string } }>("/admin/queues/:name/resume", async (req, reply) => {
    const queue = queueOrNotFound(req.params.name);
    if (!queue) return reply.code(404).send({ error: "unknown queue" });
    await queue.resume();
    return { paused: false };
  });

  app.post<{ Params: { name: string } }>("/admin/queues/:name/retry-failed", async (req, reply) => {
    const queue = queueOrNotFound(req.params.name);
    if (!queue) return reply.code(404).send({ error: "unknown queue" });
    const failed = await queue.getJobs(["failed"], 0, 1000);
    await Promise.all(failed.map((job) => job.retry()));
    return { retried: failed.length };
  });

  app.post<{ Params: { name: string }; Body: { state?: string } }>(
    "/admin/queues/:name/clean",
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      const state = (req.body?.state as JobState) ?? "completed";
      if (!JOB_STATES.includes(state)) return reply.code(400).send({ error: "invalid state" });
      const removed = await queue.clean(0, 1000, state);
      return { removed: removed.length };
    },
  );
}
