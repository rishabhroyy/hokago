import { useEffect, useState } from "react";
import type { ContinueWatchingEntry } from "@hokago/contract/playback";
import { api } from "../api-client";
import { fetchLibraries, fetchLibraryItems, type MediaCard } from "../browse-api";
import { useProfileId } from "../profile";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { HUE_CLASS, hueFor, iconFor, type TileItem } from "../ui/Tile";
import { Row } from "../ui/Row";
import { continueWatchingToTile, cardToTile } from "../ui/tile-mapping";

export function HomeView() {
  const { navigate } = useRouter();
  const profileId = useProfileId();
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingEntry[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<MediaCard[]>([]);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    api
      .GET("/continue-watching", { params: { query: { profileId } } })
      .then(({ data }) => {
        if (!cancelled && data) setContinueWatching(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    fetchLibraries()
      .then((libs) => Promise.all(libs.map((l) => fetchLibraryItems(l.id))))
      .then((lists) => {
        if (cancelled) return;
        const merged = lists.flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        setRecentlyAdded(merged.slice(0, 18));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openDetail = (item: TileItem) => navigate(paths.detail(item.id));

  const heroEntry = continueWatching.find((e) => !e.upNext) ?? null;
  const heroCard = !heroEntry ? (recentlyAdded[0] ?? null) : null;
  if (!heroEntry && !heroCard) {
    return <div className="pt-[62px]" />;
  }

  const heroId = heroEntry ? heroEntry.mediaItem.id : heroCard!.id;
  const heroTitle = heroEntry ? heroEntry.mediaItem.title : heroCard!.title;
  const heroYear = heroEntry ? heroEntry.mediaItem.year : heroCard!.year;
  const heroMediaFileId = heroEntry ? heroEntry.mediaItem.mediaFileId : heroCard!.mediaFileId;
  const heroSub = heroEntry
    ? heroEntry.mediaItem.kind === "EPISODE" &&
      heroEntry.mediaItem.seasonNumber != null &&
      heroEntry.mediaItem.episodeNumber != null
      ? `Season ${heroEntry.mediaItem.seasonNumber} · Episode ${heroEntry.mediaItem.episodeNumber}`
      : heroEntry.mediaItem.kind === "MOVIE"
        ? "Movie"
        : "Series"
    : heroCard!.kind === "MOVIE"
      ? "Movie"
      : "Series";
  const timeLeftMs =
    heroEntry?.durationMs != null ? Math.max(0, heroEntry.durationMs - heroEntry.positionMs) : null;
  const timeLeftLabel = timeLeftMs != null ? `${Math.max(1, Math.round(timeLeftMs / 60_000))} min left` : null;

  return (
    <div className="pt-[62px]">
      <div
        className={`relative mx-12 mt-7 h-[340px] overflow-hidden rounded-hero shadow-[inset_0_2px_0_rgba(255,255,255,0.4),0_10px_30px_-12px_rgba(120,80,60,0.35)] ${HUE_CLASS[hueFor(heroId)]}`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[44%] bg-gradient-to-b from-white/25 to-transparent" />
        <div className="pointer-events-none absolute right-[6%] top-1/2 h-[190px] w-[190px] -translate-y-1/2 animate-bob text-white opacity-90">
          <Icon name={iconFor(heroId)} className="h-full w-full drop-shadow-[0_4px_10px_rgba(90,50,30,0.25)]" />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[rgba(60,40,30,0.5)] via-[rgba(60,40,30,0.15)] to-transparent" />
        <div className="relative z-[2] flex h-full max-w-[560px] flex-col justify-end px-11 pb-9 text-white">
          <div className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] opacity-85">
            {heroEntry ? "Continue watching" : "Recently added"}
          </div>
          <h1 className="mb-3 font-display text-[40px] font-bold">{heroTitle}</h1>
          <div className="mb-5 flex items-center gap-3.5 text-[13px] opacity-90">
            {heroYear != null && <span>{heroYear}</span>}
            {heroYear != null && <span className="opacity-50">·</span>}
            <span>{heroSub}</span>
            {timeLeftLabel && (
              <>
                <span className="opacity-50">·</span>
                <span>{timeLeftLabel}</span>
              </>
            )}
          </div>
          <div className="flex gap-3">
            <button
              className="btn relative inline-flex items-center gap-2.5 overflow-hidden rounded-full bg-white px-[26px] py-[13px] text-[14.5px] font-bold text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_6px_16px_-6px_rgba(0,0,0,0.3)] transition-transform duration-150 ease-snap hover:-translate-y-0.5 active:scale-[.96]"
              onClick={() =>
                heroMediaFileId
                  ? navigate(paths.player(heroMediaFileId, heroId, profileId ?? "dev"))
                  : navigate(paths.detail(heroId))
              }
            >
              <Icon name="play" className="h-4 w-4" />
              {heroEntry ? "Resume" : "Play"}
            </button>
            <button
              className="btn relative inline-flex items-center gap-2.5 overflow-hidden rounded-full border border-white/35 bg-white/20 px-[26px] py-[13px] text-[14.5px] font-bold text-white backdrop-blur-md transition-colors hover:bg-white/30 active:scale-[.96]"
              onClick={() => navigate(paths.detail(heroId))}
            >
              <Icon name="info" className="h-4 w-4" />
              Details
            </button>
          </div>
        </div>
      </div>

      <Row title="Continue watching" items={continueWatching.map(continueWatchingToTile)} onOpen={openDetail} />
      <Row title="Recently added" items={recentlyAdded.map(cardToTile)} onOpen={openDetail} />
    </div>
  );
}
