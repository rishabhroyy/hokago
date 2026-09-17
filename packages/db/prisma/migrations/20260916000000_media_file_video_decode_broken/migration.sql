-- Sticky flag: the client already tried the audio-decode fallback for this
-- file (REMUX with audio re-encoded) and the decode error recurred anyway,
-- proving audio was never the problem. Video is never remux-fixable, so
-- every future session skips straight to TRANSCODE instead of repeating a
-- REMUX that can't help.
ALTER TABLE "media_files" ADD COLUMN "videoDecodeBroken" BOOLEAN NOT NULL DEFAULT false;
