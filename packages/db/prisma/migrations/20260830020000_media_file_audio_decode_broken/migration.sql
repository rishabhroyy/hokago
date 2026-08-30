-- Sticky flag: the client reported this file's direct-play stream as
-- undecodable (e.g. malformed HE-AAC signaling from a bad source rip).
-- Codec name alone can't catch this, so every future session skips
-- straight to REMUX with audio forced to re-encode instead of repeating
-- the same broken direct play.
ALTER TABLE "media_files" ADD COLUMN "audioDecodeBroken" BOOLEAN NOT NULL DEFAULT false;
