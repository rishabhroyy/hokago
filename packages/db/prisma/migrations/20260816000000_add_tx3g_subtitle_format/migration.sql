-- Additive enum value: mp4 subtitle tracks (mov_text) were previously skipped
-- at ingest because no SubtitleFormat mapped the codec. TX3G is text, never
-- burn-in — client-rendered via on-demand ffmpeg extraction to SRT.
ALTER TYPE "SubtitleFormat" ADD VALUE 'TX3G';