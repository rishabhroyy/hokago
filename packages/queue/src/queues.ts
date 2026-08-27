export const QUEUE_NAMES = {
  SCAN: "scan",
  ARTWORK: "artwork",
  TRICKPLAY: "trickplay",
  METADATA_TVMAZE: "metadata-tvmaze",
  METADATA_WIKIPEDIA: "metadata-wikipedia",
  METADATA_ANILIST: "metadata-anilist",
  METADATA_MAL: "metadata-mal",
  DOWNLOAD: "download",
  ACQUIRE: "acquire",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ScanJobData {
  libraryId: string;
  mode?: "light" | "heavy";
}

export interface ArtworkJobData {
  mediaItemId: string;
  filePath: string;
  dir: string;
  durationMs: number | null;
}

export interface TrickplayJobData {
  mediaItemId: string;
  mediaFileId: string;
  filePath: string;
  durationMs: number | null;
}

export interface MetadataJobData {
  mediaItemId: string;
  libraryId: string;
  kind: "MOVIE" | "SERIES";
  title: string;
  year: number | null;
}

export interface DownloadJobData {
  downloadId: string;
}
export interface AcquireJobData { acquireId: string; }

/** Deterministic BullMQ jobIds so re-enqueueing already-queued work is a no-op (/). */
export const scanJobId = (libraryId: string): string => libraryId;
export const artworkJobId = (mediaItemId: string): string => `artwork-${mediaItemId}`;
export const trickplayJobId = (mediaFileId: string): string => `trickplay-${mediaFileId}`;
export const metadataJobId = (provider: string, mediaItemId: string): string => `metadata-${provider}-${mediaItemId}`;
export const downloadJobId = (downloadId: string): string => `download-${downloadId}`;
export const acquireJobId = (id: string): string => `acquire-${id}`;

/** After this many failures, poison-pill: stop retrying, flip MediaItem.state . */
export const JOB_FAILURE_THRESHOLD = 3;
