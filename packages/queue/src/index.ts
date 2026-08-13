export { getConnection } from "./connection.js";
export {
  QUEUE_NAMES,
  JOB_FAILURE_THRESHOLD,
  scanJobId,
  artworkJobId,
  trickplayJobId,
  metadataJobId,
  downloadJobId,
  type QueueName,
  type ScanJobData,
  type ArtworkJobData,
  type TrickplayJobData,
  type MetadataJobData,
  type DownloadJobData,
} from "./queues.js";
export { Queue, Worker, QueueEvents } from "bullmq";
export type { Job } from "bullmq";
