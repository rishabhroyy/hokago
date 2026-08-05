import { useRef } from "react";
import { Icon, type IconName } from "./icons";
import { useWiiSound } from "./useWiiSound";
import { spawnStar, useReducedMotion, zoomOpen } from "./effects";

export const HUE_CLASS: Record<number, string> = {
  1: "bg-gradient-to-br from-p1a to-p1b",
  2: "bg-gradient-to-br from-p2a to-p2b",
  3: "bg-gradient-to-br from-p3a to-p3b",
  4: "bg-gradient-to-br from-p4a to-p4b",
  5: "bg-gradient-to-br from-p5a to-p5b",
  6: "bg-gradient-to-br from-p6a to-p6b",
};

// No genre/icon field exists on MediaItem — hue and icon are derived
// deterministically from the id so the same title always looks the same.
const ICON_POOL: IconName[] = ["window", "teacup", "music", "cherry", "cloudsun", "paperplane", "lantern", "cassette"];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function hueFor(id: string): number {
  return (hashId(id) % 6) + 1;
}

export function iconFor(id: string): IconName {
  return ICON_POOL[hashId(id) % ICON_POOL.length];
}

export interface TileItem {
  id: string;
  title: string;
  posterUrl: string | null;
  subLabel: string;
  badge?: string;
  progress?: number;
}

export function Tile({
  item,
  onOpen,
  onPrefetch,
}: {
  item: TileItem;
  onOpen: (item: TileItem, artEl: HTMLElement) => void;
  onPrefetch?: (item: TileItem) => void;
}) {
  const artRef = useRef<HTMLDivElement>(null);
  const s = useWiiSound();
  const reduced = useReducedMotion();

  const onMove = (e: React.PointerEvent) => {
    if (reduced) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -7;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 7;
    if (artRef.current) artRef.current.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
  };
  const onLeave = () => {
    if (artRef.current) artRef.current.style.transform = "";
  };

  return (
    <button
      className="tile group w-full cursor-pointer bg-transparent text-left transition-transform duration-200 ease-snap hover:-translate-y-2 active:translate-y-[-3px] active:scale-[.98]"
      style={{ perspective: 640 }}
      onPointerEnter={() => {
        s.hover();
        onPrefetch?.(item);
      }}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onClick={(e) => {
        s.select();
        if (!reduced) spawnStar(e.clientX, e.clientY);
        if (artRef.current) zoomOpen(artRef.current, () => onOpen(item, artRef.current!), reduced);
      }}
    >
      {/* wii channel: glossy white frame, art floats inside */}
      <div
        ref={artRef}
        className={`art relative rounded-[20px] bg-card p-[5px] shadow-panel transition-shadow duration-200 [transform-style:preserve-3d] group-hover:shadow-wii-ring ${reduced ? "" : "group-hover:animate-wiipulse"}`}
      >
        <div
          className={`relative flex aspect-[2/3] items-center justify-center overflow-hidden rounded-[15px] ${item.posterUrl ? "bg-paper-2" : HUE_CLASS[hueFor(item.id)]}`}
        >
          {item.posterUrl ? (
            <img src={item.posterUrl} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <>
              <span className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[46%] bg-gradient-to-b from-white/42 via-white/8 to-transparent" />
              <Icon
                name={iconFor(item.id)}
                className="relative z-[2] h-[38%] w-[38%] text-white opacity-95 drop-shadow-[0_2px_4px_rgba(90,50,30,.22)]"
              />
            </>
          )}
          <span className="pointer-events-none absolute inset-0 z-[1] rounded-[15px] ring-1 ring-inset ring-white/20" />

          {item.badge && (
            <span className="absolute left-2 top-2 z-[3] rounded-full bg-white/95 px-2 py-[3px] font-mono text-kicker dark:bg-paper font-bold uppercase tracking-[0.08em] text-wii-ink shadow-[0_2px_6px_-2px_rgba(60,40,30,0.4)]">
              {item.badge}
            </span>
          )}
          {item.progress != null && (
            <span className="absolute inset-x-2 bottom-2 z-[3] h-[5px] overflow-hidden rounded-full bg-black/25 shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]">
              <b
                className="block h-full rounded-full bg-gradient-to-r from-wii-2 to-wii shadow-[0_0_6px_rgba(79,184,224,0.9)]"
                style={{ width: `${Math.round(item.progress * 100)}%` }}
              />
            </span>
          )}
        </div>
      </div>
      <div
        className="t-name mt-2.5 overflow-hidden text-ellipsis whitespace-nowrap px-1 text-card-title font-bold text-ink transition-colors group-hover:text-wii-deep"
        title={item.title}
      >
        {item.title}
      </div>
      <div className="t-sub mt-0.5 px-1 font-mono text-kicker uppercase tracking-[0.1em] text-ink-3">{item.subLabel}</div>
    </button>
  );
}
