import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Queue, getConnection, QUEUE_NAMES, type QueueName } from "@hokago/queue";
import {
  QueueListResponse,
  QueueParams,
  QueueJobsQuery,
  QueueJobsResponse,
  QueuePausedResponse,
  QueueRetriedResponse,
  QueueCleanBody,
  QueueCleanResponse,
  ErrorResponse,
} from "@hokago/contract/admin";
import type { ZodFastifyInstance } from "./fastify-zod.js";

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
export async function registerAdminRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get("/admin", async (_req, reply) => {
    const html = await readFile(path.join(__dirname, "admin.html"), "utf-8");
    reply.type("text/html").send(html);
  });

  app.get("/admin/queues", { schema: { response: { 200: QueueListResponse } } }, async () => {
    const result = await Promise.all(
      Object.entries(queues).map(async ([name, queue]) => ({
        name,
        paused: await queue.isPaused(),
        counts: await queue.getJobCounts(...JOB_STATES),
      })),
    );
    return result;
  });

  app.get(
    "/admin/queues/:name/jobs",
    {
      schema: {
        params: QueueParams,
        querystring: QueueJobsQuery,
        response: { 200: QueueJobsResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      const state = req.query.state ?? "failed";

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

  app.post(
    "/admin/queues/:name/pause",
    { schema: { params: QueueParams, response: { 200: QueuePausedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      await queue.pause();
      return { paused: true };
    },
  );

  app.post(
    "/admin/queues/:name/resume",
    { schema: { params: QueueParams, response: { 200: QueuePausedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      await queue.resume();
      return { paused: false };
    },
  );

  app.post(
    "/admin/queues/:name/retry-failed",
    { schema: { params: QueueParams, response: { 200: QueueRetriedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      const failed = await queue.getJobs(["failed"], 0, 1000);
      await Promise.all(failed.map((job) => job.retry()));
      return { retried: failed.length };
    },
  );

  app.post(
    "/admin/queues/:name/clean",
    {
      schema: {
        params: QueueParams,
        body: QueueCleanBody.optional(),
        response: { 200: QueueCleanResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      const state = req.body?.state ?? "completed";
      const removed = await queue.clean(0, 1000, state);
      return { removed: removed.length };
    },
  );
}
