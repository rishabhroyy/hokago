export { getConnection } from "./connection.js";
export {
  QUEUE_NAMES,
  JOB_FAILURE_THRESHOLD,
  scanJobId,
  artworkJobId,
  metadataJobId,
  type QueueName,
  type ScanJobData,
  type ArtworkJobData,
  type MetadataJobData,
} from "./queues.js";
export { Queue, Worker, QueueEvents } from "bullmq";
export type { Job } from "bullmq";
