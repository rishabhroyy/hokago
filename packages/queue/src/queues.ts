export const QUEUE_NAMES = {
  SCAN: "scan",
  ARTWORK: "artwork",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ScanJobData {
  libraryId: string;
}

export interface ArtworkJobData {
  mediaItemId: string;
  filePath: string;
  dir: string;
  durationMs: number | null;
}

/** Deterministic BullMQ jobIds so re-enqueueing already-queued work is a no-op (§9.6.1/§9.6.2). */
export const scanJobId = (libraryId: string): string => libraryId;
export const artworkJobId = (mediaItemId: string): string => `artwork-${mediaItemId}`;

/** After this many failures, poison-pill: stop retrying, flip MediaItem.state (§9.6.6). */
export const JOB_FAILURE_THRESHOLD = 3;
