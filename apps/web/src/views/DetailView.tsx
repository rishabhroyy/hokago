import { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodeCard } from "@hokago/contract/browse";
import { fetchMediaItemDetail, prefetchMediaItemDetail, type MediaItemDetail } from "../browse-api";
import { useProfileId } from "../profile";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { HUE_CLASS, hueFor, iconFor, type TileItem } from "../ui/Tile";
import { Row } from "../ui/Row";
import { cardToTile } from "../ui/tile-mapping";
import { useWiiSound } from "../ui/useWiiSound";
import { popAndPing, useReducedMotion, useStaggerEntrance } from "../ui/effects";
import { sanitizeOverview } from "../ui/sanitize";

function seasonLabel(seasonNumber: number | null): string {
  if (seasonNumber == null) return "Episodes";
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function trackLabel(track: { streamIndex: number; lang: string | null }): string {
  return track.lang ? track.lang.toUpperCase() : `Track ${track.streamIndex}`;
}

/** Overviews arrive as provider HTML (<i>, <b>, <a>, <br>…) — sanitized and rendered for real. */
function Overview({ text }: { text: string }) {
  return (
    <p
      className="max-w-[680px] text-body leading-[1.75] text-ink-2 [text-wrap:pretty] [&_a]:font-semibold [&_a]:text-wii-deep [&_a]:underline"
      dangerouslySetInnerHTML={{ __html: sanitizeOverview(text) }}
    />
  );
}

function SeasonGrid({ season, eps, onOpen }: { season: number | null; eps: EpisodeCard[]; onOpen: (ep: EpisodeCard, el: HTMLElement) => void }) {
  const s = useWiiSound();
  const gridRef = useRef<HTMLDivElement>(null);
  useStaggerEntrance(gridRef, [eps]);

  return (
    <div>
      <h3 className="mb-[18px] mt-9 flex items-baseline gap-3 font-display text-section font-bold tracking-[0.01em]">
        {seasonLabel(season)}
        <span className="rounded-full bg-paper px-2.5 py-0.5 font-mono text-kicker font-bold text-wii-ink ring-1 ring-line">
          {eps.length}
        </span>
      </h3>
      <div ref={gridRef} className="grid gap-x-[20px] gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
        {eps.map((ep) => (
          <button
            key={ep.id}
            className="group cursor-pointer text-left transition-transform duration-200 ease-snap hover:-translate-y-1.5 active:scale-[.98]"
            onPointerEnter={() => s.hover()}
            onClick={(e) => onOpen(ep, e.currentTarget)}
          >
            <div className="relative rounded-[18px] bg-card p-[5px] shadow-panel transition-shadow duration-200 group-hover:shadow-wii-ring">
              <div
                className={`relative aspect-video overflow-hidden rounded-[13px] ${ep.posterUrl ? "bg-paper-2" : HUE_CLASS[hueFor(ep.id)]}`}
              >
                {ep.posterUrl ? (
                  <img src={ep.posterUrl} alt={ep.title} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Icon name={iconFor(ep.id)} className="h-[28%] w-[28%] text-white opacity-85" />
                  </span>
                )}
                <span className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[42%] bg-gradient-to-b from-white/20 to-transparent" />
                <span className="pointer-events-none absolute inset-0 z-[1] rounded-[13px] ring-1 ring-inset ring-white/20" />
                <span className="absolute left-[9px] top-2 z-[2] rounded-full bg-white/95 px-2 py-[3px] font-mono text-kicker dark:bg-paper font-bold text-ink shadow-[0_2px_6px_-2px_rgba(60,40,30,0.4)]">
                  EP {ep.episodeNumber ?? "?"}
                </span>
                {ep.runtimeMs != null && (
                  <span className="absolute bottom-2 right-[9px] z-[2] rounded-full bg-black/55 px-2 py-[3px] font-mono text-kicker font-bold text-white backdrop-blur-sm">
                    {Math.round(ep.runtimeMs / 60_000)}m
                  </span>
                )}
                <span className="absolute inset-0 z-[2] flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full wii-btn text-white shadow-btn-blue">
                    <Icon name="play" className="ml-0.5 h-5 w-5" />
                  </span>
                </span>
              </div>
            </div>
            <div className="mt-2.5 overflow-hidden text-ellipsis whitespace-nowrap px-1 text-card-title font-bold text-ink transition-colors group-hover:text-wii-deep" title={ep.title}>
              {ep.title}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn btn-ghost absolute left-12 top-[84px] z-[4] !px-[18px] !py-2.5 text-meta max-[820px]:left-4" onClick={onClick}>
      <Icon name="back" className="h-[15px] w-[15px]" />
      Back
    </button>
  );
}

function Banner({ itemId, backdropUrl, posterUrl, onBack }: { itemId: string; backdropUrl?: string | null; posterUrl?: string | null; onBack: () => void }) {
  return (
    <header className={`relative h-[340px] overflow-hidden ${HUE_CLASS[hueFor(itemId)]} max-[820px]:h-[300px]`}>
      {backdropUrl ? (
        <img src={backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : posterUrl ? (
        <img
          src={posterUrl}
          alt=""
          className="absolute inset-0 h-full w-full scale-125 object-cover opacity-70 blur-[28px] saturate-[1.15]"
        />
      ) : (
        <div className="pointer-events-none absolute bottom-[-26px] right-[5%] h-[210px] w-[210px] text-white opacity-90 max-[820px]:h-[150px] max-[820px]:w-[150px] max-[820px]:opacity-60">
          <Icon name={iconFor(itemId)} className="h-full w-full drop-shadow-[0_6px_14px_rgba(90,50,30,0.3)]" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[40%] bg-gradient-to-b from-white/25 to-transparent" />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(0deg,#F5EFE4_4%,rgba(245,239,228,0.3)_42%,transparent_72%)]" />
      <div
        className="pointer-events-none absolute inset-0 z-[1] opacity-50"
        style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}
      />
      <BackButton onClick={onBack} />
    </header>
  );
}

function DetailSkeleton({ itemId }: { itemId: string }) {
  const { navigate } = useRouter();
  return (
    <div className="detail min-h-screen">
      <Banner itemId={itemId} onBack={() => navigate(paths.home())} />
      <div className="relative z-[3] mx-12 -mt-24 pb-16 max-[820px]:mx-4">
        <div className="panel rounded-[30px] p-9">
          <div className="flex items-start gap-9 max-[820px]:flex-col">
            <div className="skeleton -mt-[120px] aspect-[2/3] w-48 shrink-0 rounded-[26px] border-[5px] border-white max-[820px]:mt-0 max-[820px]:w-[140px]" />
            <div className="flex w-full max-w-xl flex-col gap-3 pt-1">
              <div className="skeleton h-10 w-72 rounded-full" />
              <div className="skeleton h-5 w-44 rounded-full" />
              <div className="skeleton mt-3 h-12 w-36 rounded-full" />
              <div className="skeleton mt-2 h-4 w-full rounded-full" />
              <div className="skeleton h-4 w-2/3 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DetailView({ itemId }: { itemId: string }) {
  const { navigate } = useRouter();
  const profileId = useProfileId();
  const s = useWiiSound();
  const reduced = useReducedMotion();
  const [item, setItem] = useState<MediaItemDetail | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<number | null>(null);

  useEffect(() => {
    setItem(null);
    fetchMediaItemDetail(itemId)
      .then((detail) => {
        setItem(detail);
        setSelectedAudio(detail?.audioTracks[0]?.streamIndex ?? null);
      })
      .catch(() => {});
  }, [itemId]);

  const episodesBySeason = useMemo(() => {
    if (!item) return [];
    const groups = new Map<number | null, EpisodeCard[]>();
    for (const ep of item.episodes) {
      const key = ep.seasonNumber;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(ep);
    }
    return [...groups.entries()];
  }, [item]);

  if (!item) {
    return <DetailSkeleton itemId={itemId} />;
  }

  const firstEpisode = item.episodes[0];
  const playMediaFileId = item.kind === "SERIES" ? (firstEpisode?.mediaFileId ?? null) : item.mediaFileId;
  const playMediaItemId = item.kind === "SERIES" ? (firstEpisode?.id ?? null) : item.id;

  const openEpisode = (ep: EpisodeCard, el: HTMLElement) => {
    if (!ep.mediaFileId) return;
    s.select();
    const r = el.getBoundingClientRect();
    popAndPing(el, r.left + r.width / 2, r.top + r.height / 2, reduced);
    navigate(paths.player(ep.mediaFileId, ep.id, profileId ?? "dev"));
  };

  const openTile = (tile: TileItem) => navigate(paths.detail(tile.id));
  const prefetchTile = (tile: TileItem) => prefetchMediaItemDetail(tile.id);

  const hasEpisodes = item.episodes.length > 0;

  return (
    <div className={`detail min-h-screen ${reduced ? "" : "animate-[riseIn_.5s_cubic-bezier(.4,0,.2,1)]"}`}>
      <Banner itemId={item.id} backdropUrl={item.backdropUrl} posterUrl={item.posterUrl} onBack={() => navigate(paths.home())} />

      {/* the sheet: one glossy page holding everything about this title */}
      <div className="relative z-[3] mx-12 -mt-24 pb-16 max-[820px]:mx-4">
        <div className="panel rounded-[30px] p-9">
          <div className="flex items-start gap-9 max-[820px]:flex-col max-[820px]:gap-5">
            {/* channel-framed poster sticking up into the banner, slight wii-tilt */}
            <div className="-mt-[120px] w-48 shrink-0 -rotate-2 rounded-[26px] bg-card p-[5px] shadow-panel transition-transform duration-300 ease-snap hover:rotate-0 max-[820px]:mt-0 max-[820px]:w-[140px]">
              <div
                className={`relative flex aspect-[2/3] items-center justify-center overflow-hidden rounded-[21px] ${item.posterUrl ? "bg-paper-2" : HUE_CLASS[hueFor(item.id)]}`}
              >
                {item.posterUrl ? (
                  <img src={item.posterUrl} alt={item.title} className="h-full w-full object-cover" />
                ) : (
                  <>
                    <span className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[42%] bg-gradient-to-b from-white/35 to-transparent" />
                    <Icon name={iconFor(item.id)} className="h-[40%] w-[40%] text-white opacity-90" />
                  </>
                )}
                <span className="pointer-events-none absolute inset-0 z-[1] rounded-[21px] ring-1 ring-inset ring-white/20" />
              </div>
            </div>

            <div className="min-w-0 flex-1 pt-1">
              <h1 className="mb-3 font-display text-title-xl font-black leading-[1.04] tracking-[-0.01em] [text-wrap:balance]">
                {item.title}
              </h1>
              {item.originalTitle && item.originalTitle !== item.title && (
                <p className="mb-3 -mt-1 text-body font-medium tracking-[0.02em] text-ink-3">{item.originalTitle}</p>
              )}
              <div className="mb-5 flex flex-wrap items-center gap-2 text-small font-semibold text-ink-2">
                <span className="rounded-full bg-paper px-3 py-1 ring-1 ring-line">
                  {item.kind === "MOVIE" ? "Movie" : "Series"}
                </span>
                {item.year != null && (
                  <span className="rounded-full bg-paper px-3 py-1 font-mono ring-1 ring-line">{item.year}</span>
                )}
                {item.rating != null && (
                  <span className="flex items-center gap-1.5 rounded-full bg-paper px-3 py-1 font-mono ring-1 ring-line">
                    <Icon name="star" className="h-3.5 w-3.5 text-wii-deep" />
                    {item.rating.toFixed(1)}
                  </span>
                )}
                {item.kind === "SERIES" && hasEpisodes && (
                  <span className="rounded-full bg-paper px-3 py-1 ring-1 ring-line">{item.episodes.length} episodes</span>
                )}
              </div>

              {item.genres.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {item.genres.map((genre) => (
                    <span
                      key={genre}
                      className="rounded-full bg-wii-deep/[.08] px-3 py-1 text-small font-bold tracking-[0.03em] text-wii-deep ring-1 ring-wii-deep/15 dark:bg-wii-deep/15 dark:text-wii-2"
                    >
                      {genre}
                    </span>
                  ))}
                  {item.studio && (
                    <span className="ml-1 text-small font-medium text-ink-3">
                      {item.kind === "MOVIE" ? "Studio" : "Network"}: {item.studio}
                    </span>
                  )}
                </div>
              )}

              <div className="mb-5 flex items-center gap-3 max-[820px]:flex-wrap">
                {playMediaFileId && (
                  <button
                    className="btn btn-primary"
                    onClick={(e) => {
                      s.select();
                      popAndPing(e.currentTarget, e.clientX, e.clientY, reduced);
                      navigate(paths.player(playMediaFileId, playMediaItemId!, profileId ?? "dev", selectedAudio));
                    }}
                  >
                    <Icon name="play" className="h-4 w-4" />
                    {item.kind === "SERIES" ? "Play S1 · E1" : "Play"}
                  </button>
                )}
              </div>

              {item.audioTracks.length >= 2 && (
                <div className="mb-5 flex items-center gap-2">
                  <span className="mr-1 font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">Audio</span>
                  {item.audioTracks.map((track) => (
                    <button
                      key={track.streamIndex}
                      className={`rounded-full px-4 py-2 text-small font-bold transition-all duration-150 ease-snap active:scale-95 ${
                        selectedAudio === track.streamIndex
                          ? "wii-btn text-white shadow-btn-blue"
                          : "bg-card text-ink-2 shadow-panel hover:text-wii-deep"
                      }`}
                      onClick={() => {
                        s.hover();
                        setSelectedAudio(track.streamIndex);
                      }}
                    >
                      {trackLabel(track)}
                    </button>
                  ))}
                </div>
              )}

              {item.overview && <Overview text={item.overview} />}
            </div>
          </div>

          {hasEpisodes && <div className="my-2 h-px bg-line/80" />}

          {episodesBySeason.map(([season, eps]) => (
            <SeasonGrid key={season ?? "none"} season={season} eps={eps} onOpen={openEpisode} />
          ))}
        </div>
      </div>

 {/* movie-series children — TV children are SEASONs, already
          represented by the season grids above, so don't double them up */}
      {item.children.some((c) => c.kind === "MOVIE") && (
        <Row
          title="In this series"
          items={item.children.filter((c) => c.kind === "MOVIE").map(cardToTile)}
          onOpen={openTile}
          onPrefetch={prefetchTile}
        />
      )}

      {item.collections.map((collection) => (
        <Row
          key={collection.id}
          title={collection.name}
          items={collection.entries.map((e) => cardToTile(e.item))}
          onOpen={openTile}
          onPrefetch={prefetchTile}
        />
      ))}
      <div className="pb-16" />
    </div>
  );
}
