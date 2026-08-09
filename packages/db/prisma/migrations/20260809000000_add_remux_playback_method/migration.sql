-- Additive enum value: the REMUX tier (copy-remux to fragmented MP4) between
-- direct play and transcode. No rows reference it yet, so no backfill needed.
ALTER TYPE "PlaybackMethod" ADD VALUE 'REMUX';
