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
 * Every slide is full-bleed landscape — backdrop, else the poster cropped —
 * sitting under the transparent nav and fading down into the first rail.
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
  const hasActions = slide.mediaFileId != null || slide.detailId != null;

  return (
    // billboard: full-bleed art under the transparent nav, fading down into the page
    <section
      className="group/hero relative h-[min(82vh,820px)] min-h-[540px] overflow-hidden max-[820px]:h-[74vh] max-[820px]:min-h-[460px]"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="art-fade absolute inset-0">
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
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </div>
          );
        })}
        {/* legibility: the copy sits on a warm left-hand shade; phones get a heavier one under full-width text */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(18,17,16,0.85)_0%,rgba(18,17,16,0.4)_38%,transparent_65%)] max-[820px]:bg-[linear-gradient(0deg,rgba(18,17,16,0.85)_20%,rgba(18,17,16,0.2)_70%)]" />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-[24%] px-12 max-[820px]:bottom-[16%] max-[820px]:px-5">
        <div key={`${slide.title}-${active}`} className="pointer-events-auto max-w-[620px] animate-riseIn text-white">
          <h1 className="font-display text-display font-black [text-shadow:0_2px_24px_rgba(0,0,0,0.35)] [text-wrap:balance] max-[820px]:text-[34px] max-[820px]:leading-[1.1]">
            {slide.title}
          </h1>
          <p className="mt-3 text-[15px] font-medium text-white/80 [text-shadow:0_1px_8px_rgba(0,0,0,0.4)] max-[820px]:text-meta">
            {[slide.label, slide.sub, slide.year, slide.timeLeftLabel].filter((x) => x != null && x !== "").join(", ")}
          </p>
          {slide.progress != null && (
            <div className="mt-4 h-[6px] w-[320px] max-w-full overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-gradient-to-r from-wii-2 to-wii shadow-[0_0_10px_rgba(143,224,245,0.9)]"
                style={{ width: `${Math.round(slide.progress * 100)}%` }}
              />
            </div>
          )}
          {hasActions && (
            <div className="mt-6 flex gap-3 max-[820px]:mt-5">
              {slide.mediaFileId != null && (
                <button className="btn btn-primary" onClick={() => onPlay(slide)}>
                  <Icon name="play" className="h-4 w-4" />
                  {slide.progress != null ? "Resume" : "Play"}
                </button>
              )}
              {slide.detailId != null && (
                <button className="btn btn-ghost" onPointerEnter={() => onPrefetch?.(slide)} onClick={() => onDetail(slide)}>
                  <Icon name="info" className="h-4 w-4" />
                  More info
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Wii-style page pills — the active one fills over the rotation interval */}
      {count > 1 && (
        <div className="absolute bottom-[24%] right-12 flex items-center gap-2 max-[820px]:hidden">
          {slides.map((sld, i) => (
            <button
              key={`${sld.title}-${i}`}
              aria-label={`Go to slide ${i + 1}`}
              className="h-[5px] w-10 overflow-hidden rounded-full bg-white/25 transition-colors hover:bg-white/45"
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
      {count > 1 && (
        <button
          aria-label="Next slide"
          className="absolute right-0 top-[20%] hidden h-[50%] w-12 items-center justify-center text-white/70 transition-colors hover:text-white group-hover/hero:flex pointer-coarse:hidden"
          onClick={() => go(1)}
        >
          <Icon name="back" className="h-6 w-6 rotate-180" />
        </button>
      )}
    </section>
  );
}
