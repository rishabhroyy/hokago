import { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodeCard } from "@hokago/contract/browse";
import { fetchMediaItemDetail, type MediaItemDetail } from "../browse-api";
import { useProfileId } from "../profile";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { HUE_CLASS, hueFor, iconFor } from "../ui/Tile";
import { useWiiSound } from "../ui/useWiiSound";
import { popAndPing, useReducedMotion, useStaggerEntrance } from "../ui/effects";

function seasonLabel(seasonNumber: number | null): string {
  if (seasonNumber == null) return "Episodes";
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function trackLabel(track: { streamIndex: number; lang: string | null }): string {
  return track.lang ? track.lang.toUpperCase() : `Track ${track.streamIndex}`;
}

function SeasonGrid({ season, eps, onOpen }: { season: number | null; eps: EpisodeCard[]; onOpen: (ep: EpisodeCard, el: HTMLElement) => void }) {
  const s = useWiiSound();
  const gridRef = useRef<HTMLDivElement>(null);
  useStaggerEntrance(gridRef, [eps]);

  return (
    <div>
      <h3 className="mb-[18px] mt-9 font-display text-[19px] font-bold">{seasonLabel(season)}</h3>
      <div ref={gridRef} className="grid gap-x-[18px] gap-y-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {eps.map((ep) => (
          <button
            key={ep.id}
            className="group cursor-pointer text-left"
            onPointerEnter={() => s.hover()}
            onClick={(e) => onOpen(ep, e.currentTarget)}
          >
            <div
              className={`relative aspect-video overflow-hidden rounded-tile shadow-[0_3px_10px_-4px_rgba(120,80,60,0.25)] transition-[transform,box-shadow] duration-200 ease-snap group-hover:-translate-y-[3px] group-hover:shadow-wii-ring ${HUE_CLASS[hueFor(ep.id)]}`}
            >
              <span className="absolute inset-0 flex items-center justify-center">
                <Icon name={iconFor(ep.id)} className="h-[28%] w-[28%] text-white opacity-85" />
              </span>
              <span className="absolute left-[9px] top-2 z-[2] rounded-full bg-ink/50 px-2 py-0.5 font-mono text-[10px] font-bold text-white">
                EP {ep.episodeNumber ?? "?"}
              </span>
              {ep.runtimeMs != null && (
                <span className="absolute bottom-2 right-[9px] z-[2] rounded-md bg-ink/50 px-[7px] py-0.5 font-mono text-[9px] text-white">
                  {Math.round(ep.runtimeMs / 60_000)}m
                </span>
              )}
            </div>
            <div className="mt-2.5 text-[13.5px] font-bold text-ink">{ep.title}</div>
          </button>
        ))}
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
    return (
      <div className="detail min-h-screen overflow-y-auto">
        <div className={`relative h-[320px] overflow-hidden ${HUE_CLASS[hueFor(itemId)]}`}>
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,#F6F0E6_2%,rgba(246,240,230,0.2)_40%,transparent_65%)]" />
          <div className="pointer-events-none absolute right-[8%] top-[44%] h-[190px] w-[190px] -translate-y-1/2 animate-pulse text-white opacity-90">
            <Icon name={iconFor(itemId)} className="h-full w-full" />
          </div>
          <button
            className="absolute left-12 top-[78px] z-[3] flex items-center gap-2 rounded-full bg-ink/40 px-[18px] py-2.5 text-[13.5px] font-bold text-white backdrop-blur-md transition-colors hover:bg-ink/60"
            onClick={() => navigate(paths.home())}
          >
            <Icon name="back" className="h-[15px] w-[15px]" />
            Back
          </button>
        </div>
        <div className="px-12 pb-16">
          <div className="mb-[26px] flex items-end gap-7">
            <div
              className={`aspect-[2/3] w-40 shrink-0 animate-pulse rounded-panel border-4 border-paper shadow-[0_14px_30px_-12px_rgba(120,80,60,0.45)] ${HUE_CLASS[hueFor(itemId)]}`}
              style={{ marginTop: "-80px" }}
            />
            <div className="mb-1.5 h-9 w-64 animate-pulse rounded-full bg-paper-2" />
          </div>
        </div>
      </div>
    );
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

  return (
    <div className="detail min-h-screen overflow-y-auto">
      <div className={`relative h-[320px] overflow-hidden ${HUE_CLASS[hueFor(item.id)]}`}>
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,#F6F0E6_2%,rgba(246,240,230,0.2)_40%,transparent_65%)]" />
        <div className="pointer-events-none absolute right-[8%] top-[44%] h-[190px] w-[190px] -translate-y-1/2 text-white opacity-90">
          <Icon name={iconFor(item.id)} className="h-full w-full" />
        </div>
        <button
          className="absolute left-12 top-[78px] z-[3] flex items-center gap-2 rounded-full bg-ink/40 px-[18px] py-2.5 text-[13.5px] font-bold text-white backdrop-blur-md transition-colors hover:bg-ink/60"
          onClick={() => navigate(paths.home())}
        >
          <Icon name="back" className="h-[15px] w-[15px]" />
          Back
        </button>
      </div>

      <div className="px-12 pb-16">
        <div className="mb-[26px] flex items-end gap-7">
          <div
            className={`flex aspect-[2/3] w-40 shrink-0 items-center justify-center overflow-hidden rounded-panel border-4 border-paper shadow-[0_14px_30px_-12px_rgba(120,80,60,0.45)] ${item.posterUrl ? "bg-paper-2" : HUE_CLASS[hueFor(item.id)]}`}
            style={{ marginTop: "-80px" }}
          >
            {item.posterUrl ? (
              <img src={item.posterUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <Icon name={iconFor(item.id)} className="h-[42%] w-[42%] text-white opacity-90" />
            )}
          </div>
          <div className="pb-1.5">
            <h1 className="mb-2.5 font-display text-[34px] font-bold">{item.title}</h1>
            <div className="flex flex-wrap items-center gap-3 text-[13.5px] text-ink-2">
              {item.year != null && <span>{item.year}</span>}
              {item.year != null && <span>·</span>}
              <span>{item.kind === "MOVIE" ? "Movie" : "Series"}</span>
              {item.kind === "SERIES" && item.episodes.length > 0 && (
                <>
                  <span>·</span>
                  <span>{item.episodes.length} episodes</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mb-[22px] flex items-center gap-3">
          {playMediaFileId && (
            <button
              className="btn relative inline-flex items-center gap-2.5 overflow-hidden rounded-full bg-accent px-[26px] py-[13px] text-[14.5px] font-bold text-white shadow-[0_6px_16px_-6px_rgba(0,0,0,0.3)] transition-transform duration-150 ease-snap hover:-translate-y-0.5 active:scale-[.96]"
              onClick={(e) => {
                s.select();
                popAndPing(e.currentTarget, e.clientX, e.clientY, reduced);
                navigate(paths.player(playMediaFileId, playMediaItemId!, profileId ?? "dev", selectedAudio));
              }}
            >
              <Icon name="play" className="h-4 w-4" />
              Play
            </button>
          )}
          <button
            className="flex h-12 w-12 items-center justify-center rounded-full border border-line-2 bg-card text-ink shadow-[0_3px_10px_-4px_rgba(120,80,60,0.25)] transition-[transform,color,border-color] duration-150 ease-snap hover:border-accent hover:text-accent active:scale-90"
            title="Add to list"
          >
            <Icon name="plus" className="h-[19px] w-[19px]" />
          </button>
          <button
            className="flex h-12 w-12 items-center justify-center rounded-full border border-line-2 bg-card text-ink shadow-[0_3px_10px_-4px_rgba(120,80,60,0.25)] transition-[transform,color,border-color] duration-150 ease-snap hover:border-accent hover:text-accent active:scale-90"
            title="Download"
          >
            <Icon name="download" className="h-[19px] w-[19px]" />
          </button>
        </div>

        {item.audioTracks.length >= 2 && (
          <div className="mb-[18px] flex gap-2">
            {item.audioTracks.map((track) => (
              <button
                key={track.streamIndex}
                className={`rounded-full border px-4 py-2 text-[12.5px] font-bold transition-colors duration-150 ${
                  selectedAudio === track.streamIndex
                    ? "border-accent bg-accent text-white"
                    : "border-line-2 bg-card text-ink-2 hover:border-wii hover:text-ink"
                }`}
                onClick={() => setSelectedAudio(track.streamIndex)}
              >
                {trackLabel(track)}
              </button>
            ))}
          </div>
        )}

        {item.overview && <p className="max-w-[720px] text-[14.5px] leading-relaxed text-ink-2">{item.overview}</p>}

        {episodesBySeason.map(([season, eps]) => (
          <SeasonGrid key={season ?? "none"} season={season} eps={eps} onOpen={openEpisode} />
        ))}
      </div>
    </div>
  );
}
