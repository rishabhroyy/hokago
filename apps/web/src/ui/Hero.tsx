import { useEffect, useState } from "react";
import type { HomeSlide } from "@hokago/contract/home";
import { Icon } from "./icons";
import { useWiiSound } from "./useWiiSound";
import { HUE_CLASS, hueFor } from "./Tile";

const HERO_MS = 5000;

/**
 * Netflix-style hero carousel: auto-rotating crossfade slideshow that mixes
 * local content (continue watching, recently added) with the "outside world"
 * (this season's anime, on-the-air shows fetched from keyless providers).
 * Every slide is full-bleed landscape — backdrop, else the poster cropped to
 * 16:9 — never the awkward vertical poster card.
 */
export function Hero({
  slides,
  onPlay,
  onDetail,
  onPrefetch,
}: {
  slides: HomeSlide[];
  onPlay: (slide: HomeSlide) => void;
  onDetail: (slide: HomeSlide) => void;
  onPrefetch?: (slide: HomeSlide) => void;
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const s = useWiiSound();
  const count = slides.length;

  useEffect(() => {
    if (count <= 1 || paused) return;
    const id = setInterval(() => setActive((a) => (a + 1) % count), HERO_MS);
    return () => clearInterval(id);
  }, [count, paused]);

  if (count === 0) return null;

  const slide = slides[active % count];
  const go = (dir: 1 | -1) => {
    s.page(dir);
    setActive((a) => (a + dir + count) % count);
  };
  const artUrl = slide.backdropUrl ?? slide.posterUrl;
  const hasActions = slide.mediaFileId != null || slide.detailId != null;

  return (
    <section className="mx-12 mt-2 rounded-[34px] bg-card p-[7px] shadow-panel max-[820px]:mx-4">
      <div
        className="group/hero relative h-[400px] overflow-hidden rounded-[27px] max-[820px]:h-[340px]"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
      >
        {/* crossfading full-bleed landscape art layer */}
        {slides.map((sld, i) => {
          const art = sld.backdropUrl ?? sld.posterUrl;
          return (
            <div
              key={i}
              aria-hidden={i !== active}
              className={`absolute inset-0 transition-opacity duration-700 ease-smooth ${HUE_CLASS[hueFor(sld.title)]} ${
                i === active ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
            >
              {art && (
                <img
                  src={art}
                  alt=""
                  loading={i === 0 ? "eager" : "lazy"}
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                  className="absolute inset-0 h-full w-full object-cover [mask-image:linear-gradient(to_right,rgba(0,0,0,0.85),rgba(0,0,0,0.3))]"
                />
              )}
              {/* sparkle accents over the art */}
              <span className="pointer-events-none absolute right-[23%] top-[16%] h-9 w-9 text-white opacity-70">
                <Icon name="sparkle" className="h-full w-full" />
              </span>
              <span className="pointer-events-none absolute right-[16%] top-[58%] h-5 w-5 text-white opacity-50">
                <Icon name="sparkle" className="h-full w-full" />
              </span>
              <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[42%] bg-gradient-to-b from-white/25 to-transparent" />
              {/* left→right scrim keeps the title block readable over the art;
                  below 820px it sits under full-width text, so it darkens harder */}
              <div className="pointer-events-none absolute inset-0 z-[2] bg-[linear-gradient(to_right,rgba(50,35,25,0.38),rgba(50,35,25,0.08)_55%,rgba(50,35,25,0)_78%)] max-[820px]:bg-[linear-gradient(to_right,rgba(50,35,25,0.72),rgba(50,35,25,0.5)_50%,rgba(50,35,25,0.22)_82%,rgba(50,35,25,0.12))]" />
              {/* faint dot texture — the "printed channel" finish */}
              <div
                className="pointer-events-none absolute inset-0 z-[2] opacity-[0.5]"
                style={{
                  backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.5px)",
                  backgroundSize: "18px 18px",
                }}
              />
            </div>
          );
        })}

        {/* content — active slide only (keyed remount re-runs the entrance) */}
        <div className="pointer-events-none relative z-[3] flex h-full max-w-[640px] flex-col justify-end px-12 pb-11 text-white max-[820px]:px-[22px] max-[820px]:pb-[34px]">
          <div key={`${slide.title}-${active}`} className="pointer-events-auto animate-riseIn">
            <div className="mb-3.5 max-[820px]:mb-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/45 bg-white/20 px-3.5 py-1.5 font-mono text-kicker font-bold uppercase tracking-[0.16em] backdrop-blur-md">
                <span className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]" />
                {slide.label}
              </span>
            </div>
            <h1 className="mb-3 font-display text-display font-black leading-[1.02] tracking-[-0.015em] drop-shadow-[0_2px_8px_rgba(60,40,30,0.35)] [text-wrap:balance] max-[820px]:text-[34px] max-[820px]:leading-[1.1]">
              {slide.title}
            </h1>
            <div className="mb-4 flex items-center gap-2.5 text-small font-semibold">
              {slide.sub && (
                <span className="rounded-full border border-white/40 bg-white/20 px-3 py-1 backdrop-blur-md">{slide.sub}</span>
              )}
              {slide.year != null && (
                <span className="rounded-full border border-white/40 bg-white/20 px-3 py-1 font-mono backdrop-blur-md">
                  {slide.year}
                </span>
              )}
              {slide.timeLeftLabel && (
                <span className="rounded-full border border-white/40 bg-white/20 px-3 py-1 backdrop-blur-md">
                  {slide.timeLeftLabel}
                </span>
              )}
            </div>
            {slide.progress != null && (
              <div className="mb-5 h-[6px] w-[320px] max-w-full overflow-hidden rounded-full bg-black/25 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] max-[820px]:mb-4">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-wii-2 to-wii shadow-[0_0_10px_rgba(143,224,245,0.9)]"
                  style={{ width: `${Math.round(slide.progress * 100)}%` }}
                />
              </div>
            )}
            {hasActions && (
              <div className="flex gap-3">
                {slide.mediaFileId != null && (
                  <button className="btn btn-primary" onClick={() => onPlay(slide)}>
                    <Icon name="play" className="h-4 w-4" />
                    {slide.progress != null ? "Resume" : "Play"}
                  </button>
                )}
                {slide.detailId != null && (
                  <button
                    className="btn btn-ghost"
                    onPointerEnter={() => onPrefetch?.(slide)}
                    onClick={() => onDetail(slide)}
                  >
                    <Icon name="info" className="h-4 w-4" />
                    Details
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* prev / next */}
        <button
          aria-label="Previous slide"
          className="absolute left-6 top-1/2 z-[5] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-card/95 text-ink dark:border-white/15 opacity-0 shadow-panel backdrop-blur-sm transition-[opacity,transform,color] duration-200 ease-snap group-hover/hero:opacity-100 hover:text-wii-deep active:scale-[.88] pointer-coarse:hidden"
          onClick={() => go(-1)}
        >
          <Icon name="back" className="h-[18px] w-[18px]" />
        </button>
        <button
          aria-label="Next slide"
          className="absolute right-6 top-1/2 z-[5] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-card/95 text-ink dark:border-white/15 opacity-0 shadow-panel backdrop-blur-sm transition-[opacity,transform,color] duration-200 ease-snap group-hover/hero:opacity-100 hover:text-wii-deep active:scale-[.88] pointer-coarse:hidden"
          onClick={() => go(1)}
        >
          <Icon name="back" className="h-[18px] w-[18px] rotate-180" />
        </button>

        {/* progress pills — the active one fills over the rotation interval */}
        {count > 1 && (
          <div className="absolute bottom-5 right-8 z-[5] flex items-center gap-2">
            {slides.map((sld, i) => (
              <button
                key={`${sld.title}-${i}`}
                aria-label={`Go to slide ${i + 1}`}
                className="h-[5px] w-10 overflow-hidden rounded-full bg-white/25 backdrop-blur-sm transition-colors hover:bg-white/45"
                onClick={() => {
                  s.select();
                  setActive(i);
                }}
              >
                {i < active && <span className="block h-full bg-white/80" />}
                {i === active && (
                  <span
                    key={`fill-${i}-${paused}`}
                    className="block h-full animate-herofill rounded-full bg-white"
                    style={{ animationPlayState: paused ? "paused" : "running" }}
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
