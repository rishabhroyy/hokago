import { Prisma, type PrismaClient, type SubtitleFormat } from "@hokago/db";

import type { ProbedStream } from "./probe.js";

const SUBTITLE_FORMAT_BY_CODEC: Record<string, SubtitleFormat> = {
  ass: "ASS",
  ssa: "SSA",
  subrip: "SRT",
  srt: "SRT",
  webvtt: "VTT",
  vtt: "VTT",
  hdmv_pgs_subtitle: "PGS",
  pgssub: "PGS",
  dvd_subtitle: "VOBSUB",
  dvdsub: "VOBSUB",
  dvb_subtitle: "DVBSUB",
  dvbsub: "DVBSUB",
};

// Bitmap subtitle formats can't be rendered client-side by libass/JASSUB —
// force burn-in, which later kills Direct Play eligibility (§13.4).
const BITMAP_SUBTITLE_FORMATS = new Set<SubtitleFormat>(["PGS", "VOBSUB", "DVBSUB"]);

/** Sync MediaStream rows for one file — create/update/delete-by-key, same shape as evidence sync (§9.6.1). */
export async function syncMediaStreams(db: PrismaClient, mediaFileId: string, streams: ProbedStream[]): Promise<void> {
  const existing = await db.mediaStream.findMany({ where: { mediaFileId } });
  const seenIndexes = new Set<number>();

  for (const s of streams) {
    seenIndexes.add(s.index);
    const data = {
      type: s.type,
      codec: s.codec,
      profile: s.profile,
      lang: s.lang,
      title: s.title,
      channels: s.channels,
      sampleRate: s.sampleRate,
      width: s.width,
      height: s.height,
      frameRate: s.frameRate,
      bitDepth: s.bitDepth,
      isDefault: s.isDefault,
      isForced: s.isForced,
      isHearingImpaired: s.isHearingImpaired,
      hdrMeta: s.hdrMeta === null ? Prisma.JsonNull : (s.hdrMeta as unknown as Prisma.InputJsonValue),
    };
    await db.mediaStream.upsert({
      where: { mediaFileId_streamIndex: { mediaFileId, streamIndex: s.index } },
      create: { mediaFileId, streamIndex: s.index, ...data },
      update: data,
    });
  }

  const stale = existing.filter((s) => !seenIndexes.has(s.streamIndex));
  if (stale.length > 0) {
    await db.mediaStream.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}

/**
 * Sync SubtitleTrack rows for one file's SUBTITLE-type streams (§13.4). No DB
 * unique constraint on [mediaFileId, streamIndex] (external sidecar tracks
 * have a null streamIndex), so this is find-then-create/update, not a
 * compound-key upsert like MediaStream's.
 */
export async function syncSubtitleTracks(db: PrismaClient, mediaFileId: string, streams: ProbedStream[]): Promise<void> {
  const subtitleStreams = streams.filter((s) => s.type === "SUBTITLE");
  const existing = await db.subtitleTrack.findMany({ where: { mediaFileId, streamIndex: { not: null } } });
  const existingByIndex = new Map(existing.map((t) => [t.streamIndex, t]));
  const seenIndexes = new Set<number>();

  for (const s of subtitleStreams) {
    const format = (s.codec && SUBTITLE_FORMAT_BY_CODEC[s.codec]) ?? null;
    if (!format) continue; // unknown/unsupported subtitle codec — skip rather than guess
    seenIndexes.add(s.index);
    const data = {
      format,
      lang: s.lang,
      title: s.title,
      forced: s.isForced,
      sdh: s.isHearingImpaired,
      requiresBurnIn: BITMAP_SUBTITLE_FORMATS.has(format),
    };
    const prior = existingByIndex.get(s.index);
    if (prior) {
      await db.subtitleTrack.update({ where: { id: prior.id }, data });
    } else {
      await db.subtitleTrack.create({ data: { mediaFileId, streamIndex: s.index, ...data } });
    }
  }

  const stale = existing.filter((t) => t.streamIndex !== null && !seenIndexes.has(t.streamIndex));
  if (stale.length > 0) {
    await db.subtitleTrack.deleteMany({ where: { id: { in: stale.map((t) => t.id) } } });
  }
}
