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

const connection = getConnection();
const queues: Record<QueueName, Queue> = {
  scan: new Queue(QUEUE_NAMES.SCAN, { connection }),
  artwork: new Queue(QUEUE_NAMES.ARTWORK, { connection }),
  trickplay: new Queue(QUEUE_NAMES.TRICKPLAY, { connection }),
  "metadata-tvmaze": new Queue(QUEUE_NAMES.METADATA_TVMAZE, { connection }),
  "metadata-wikipedia": new Queue(QUEUE_NAMES.METADATA_WIKIPEDIA, { connection }),
  "metadata-anilist": new Queue(QUEUE_NAMES.METADATA_ANILIST, { connection }),
  "metadata-mal": new Queue(QUEUE_NAMES.METADATA_MAL, { connection }),
  download: new Queue(QUEUE_NAMES.DOWNLOAD, { connection }),
};

const JOB_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;
type JobState = (typeof JOB_STATES)[number];

function queueOrNotFound(name: string): Queue | null {
  return name in queues ? queues[name as QueueName] : null;
}

/** name + paused + job-counts for every queue — shared by /admin/queues and the dashboard summary. */
export async function queueSummaries() {
  return Promise.all(
    Object.entries(queues).map(async ([name, queue]) => ({
      name,
      paused: await queue.isPaused(),
      counts: await queue.getJobCounts(...JOB_STATES),
    })),
  );
}

/** Admin queue UI : view/pause/resume/retry-failed/clean per queue, backed directly by BullMQ.
 *  The HTML shell is public (it's just markup — the browser can't attach a Bearer
 *  header to a navigation), but every data/action endpoint requires an admin JWT. */
export async function registerAdminRoutes(app: ZodFastifyInstance): Promise<void> {
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  app.get("/admin/queues", { ...adminOnly, schema: { response: { 200: QueueListResponse } } }, async () => {
    return queueSummaries();
  });

  app.get(
    "/admin/queues/:name/jobs",
    {
      ...adminOnly,
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
    { ...adminOnly, schema: { params: QueueParams, response: { 200: QueuePausedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      await queue.pause();
      return { paused: true };
    },
  );

  app.post(
    "/admin/queues/:name/resume",
    { ...adminOnly, schema: { params: QueueParams, response: { 200: QueuePausedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const queue = queueOrNotFound(req.params.name);
      if (!queue) return reply.code(404).send({ error: "unknown queue" });
      await queue.resume();
      return { paused: false };
    },
  );

  app.post(
    "/admin/queues/:name/retry-failed",
    { ...adminOnly, schema: { params: QueueParams, response: { 200: QueueRetriedResponse, 404: ErrorResponse } } },
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
      ...adminOnly,
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
