import { useEffect, useState } from "react";
import type { ContinueWatchingEntry } from "@hokago/contract/playback";
import { api } from "../api-client";
import {
  fetchLibraries,
  fetchLibraryItems,
  prefetchMediaItemDetail,
  type MediaCard,
} from "../browse-api";
import { useProfileId } from "../profile";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import { HUE_CLASS, hueFor, iconFor, type TileItem } from "../ui/Tile";
import { Row } from "../ui/Row";
import { continueWatchingToTile, cardToTile } from "../ui/tile-mapping";

export function HomeView() {
  const { navigate } = useRouter();
  const profileId = useProfileId();
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingEntry[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<MediaCard[]>([]);
  const [loaded, setLoaded] = useState(false);

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
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const openDetail = (item: TileItem) => navigate(paths.detail(item.id));
  const prefetch = (item: TileItem) => prefetchMediaItemDetail(item.id);

  const heroEntry = continueWatching.find((e) => !e.upNext) ?? null;
  const heroCard = !heroEntry ? (recentlyAdded[0] ?? null) : null;

  // Warm the detail cache for whatever the hero points at — the "Details"
  // button is the most likely next click on the page.
  useEffect(() => {
    const id = heroEntry?.mediaItem.id ?? heroCard?.id;
    if (id) prefetchMediaItemDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroEntry?.mediaItem.id, heroCard?.id]);

  if (loaded && !heroEntry && !heroCard) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="panel flex max-w-[440px] flex-col items-center rounded-[32px] p-12 text-center">
          <span className="mb-6 flex h-24 w-24 items-center justify-center rounded-[28px] bg-[linear-gradient(135deg,#45ADDD,#187AA5)] text-white shadow-btn-blue">
            <LogoMark className="h-12 w-12" />
          </span>
          <h1 className="mb-2 font-display text-[28px] font-bold">welcome to hokago</h1>
          <p className="mb-8 text-[14px] leading-relaxed text-ink-2">
            nothing on the menu yet — add a library from the admin panel and your channels will show up here.
          </p>
          <a href="/admin" className="btn btn-primary">
            Open admin panel
          </a>
        </div>
      </div>
    );
  }

  const heroId = heroEntry ? heroEntry.mediaItem.id : (heroCard?.id ?? "");
  const heroTitle = heroEntry ? heroEntry.mediaItem.title : (heroCard?.title ?? "");
  const heroYear = heroEntry ? heroEntry.mediaItem.year : heroCard?.year;
  const heroPoster = heroEntry ? heroEntry.mediaItem.posterUrl : (heroCard?.posterUrl ?? null);
  const heroBackdrop = heroEntry ? heroEntry.mediaItem.backdropUrl : (heroCard?.backdropUrl ?? null);
  const heroMediaFileId = heroEntry ? heroEntry.mediaItem.mediaFileId : heroCard?.mediaFileId;
  const heroSub = heroEntry
    ? heroEntry.mediaItem.kind === "EPISODE" &&
      heroEntry.mediaItem.seasonNumber != null &&
      heroEntry.mediaItem.episodeNumber != null
      ? `S${heroEntry.mediaItem.seasonNumber} · E${heroEntry.mediaItem.episodeNumber}`
      : heroEntry.mediaItem.kind === "MOVIE"
        ? "Movie"
        : "Series"
    : heroCard?.kind === "MOVIE"
      ? "Movie"
      : "Series";
  const heroProgress =
    heroEntry?.durationMs != null && heroEntry.durationMs > 0 ? heroEntry.positionMs / heroEntry.durationMs : null;
  const timeLeftMs =
    heroEntry?.durationMs != null ? Math.max(0, heroEntry.durationMs - heroEntry.positionMs) : null;
  const timeLeftLabel = timeLeftMs != null ? `${Math.max(1, Math.round(timeLeftMs / 60_000))} min left` : null;

  return (
    <div className="pb-6 pt-[86px]">
      {heroId && (
        <section className="mx-12 mt-2 rounded-[34px] bg-card p-[7px] shadow-panel max-[820px]:mx-4">
          <div className={`relative h-[400px] overflow-hidden rounded-[27px] ${HUE_CLASS[hueFor(heroId)]} max-[820px]:h-[340px]`}>
            {/* real backdrop when we have one; soft, masked, never hotlinked (§1.1) */}
            {heroBackdrop && (
              <img
                src={heroBackdrop}
                alt=""
                className="absolute inset-0 h-full w-full object-cover [mask-image:linear-gradient(to_right,rgba(0,0,0,0.85),rgba(0,0,0,0.3))]"
              />
            )}
            {/* channel-art scene */}
            <div className="pointer-events-none absolute inset-0 z-[1]">
              {!heroPoster && !heroBackdrop && (
                <span className="absolute bottom-[-34px] right-[4%] h-[250px] w-[250px] animate-bob text-white opacity-90 max-[820px]:h-[168px] max-[820px]:w-[168px] max-[820px]:opacity-55">
                  <Icon name={iconFor(heroId)} className="h-full w-full drop-shadow-[0_6px_14px_rgba(90,50,30,0.3)]" />
                </span>
              )}
              <span className="absolute right-[23%] top-[16%] h-9 w-9 text-white opacity-70">
                <Icon name="sparkle" className="h-full w-full" />
              </span>
              <span className="absolute right-[16%] top-[58%] h-5 w-5 text-white opacity-50">
                <Icon name="sparkle" className="h-full w-full" />
              </span>
              {!heroBackdrop && heroPoster && (
                <img
                  src={heroPoster}
                  alt=""
                  className="absolute right-[3.5%] top-1/2 h-[86%] -translate-y-1/2 rotate-2 rounded-[20px] border-[5px] border-white/90 object-cover shadow-[0_18px_40px_-14px_rgba(60,40,30,0.5)]"
                />
              )}
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[42%] bg-gradient-to-b from-white/25 to-transparent" />
            <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-r from-[rgba(50,35,25,0.38)] via-[rgba(50,35,25,0.08)] to-transparent" />
            {/* faint dot texture over the scene — the "printed channel" finish */}
            <div
              className="pointer-events-none absolute inset-0 z-[2] opacity-[0.5]"
              style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}
            />

            <div className="relative z-[3] flex h-full max-w-[640px] flex-col justify-end px-12 pb-11 text-white max-[820px]:px-[22px] max-[820px]:pb-[34px]">
              <div className="mb-3.5 max-[820px]:mb-3">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/45 bg-white/20 px-3.5 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.16em] backdrop-blur-md">
                  <span className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]" />
                  {heroEntry ? "Continue watching" : "Recently added"}
                </span>
              </div>
              <h1 className="mb-3 font-display text-[48px] font-black leading-[1.02] tracking-[-0.015em] drop-shadow-[0_2px_8px_rgba(60,40,30,0.35)] [text-wrap:balance] max-[820px]:text-[34px] max-[820px]:leading-[1.1]">
                {heroTitle}
              </h1>
              <div className="mb-4 flex items-center gap-2.5 text-[12.5px] font-semibold">
                <span className="rounded-full border border-white/40 bg-white/20 px-3 py-1 backdrop-blur-md">{heroSub}</span>
                {heroYear != null && (
                  <span className="rounded-full border border-white/40 bg-white/20 px-3 py-1 font-mono backdrop-blur-md">
                    {heroYear}
                  </span>
                )}
                {timeLeftLabel && (
                  <span className="rounded-full border border-white/40 bg-white/20 px-3 py-1 backdrop-blur-md">
                    {timeLeftLabel}
                  </span>
                )}
              </div>
              {heroProgress != null && (
                <div className="mb-5 h-[6px] w-[320px] max-w-full overflow-hidden rounded-full bg-black/25 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] max-[820px]:mb-4">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-wii-2 to-wii shadow-[0_0_10px_rgba(143,224,245,0.9)]"
                    style={{ width: `${Math.round(heroProgress * 100)}%` }}
                  />
                </div>
              )}
              <div className="flex gap-3">
                <button
                  className="btn btn-primary"
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
                  className="btn btn-ghost"
                  onPointerEnter={() => prefetchMediaItemDetail(heroId)}
                  onClick={() => navigate(paths.detail(heroId))}
                >
                  <Icon name="info" className="h-4 w-4" />
                  Details
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <Row
        title="Continue watching"
        items={continueWatching.map(continueWatchingToTile)}
        onOpen={openDetail}
        onPrefetch={prefetch}
      />
      <Row title="Recently added" items={recentlyAdded.map(cardToTile)} onOpen={openDetail} onPrefetch={prefetch} />
    </div>
  );
}
