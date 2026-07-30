import { useRef } from "react";
import { Icon, type IconName } from "./icons";
import { useWiiSound } from "./useWiiSound";

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

export function Tile({ item, onOpen }: { item: TileItem; onOpen: (item: TileItem, artEl: HTMLElement) => void }) {
  const artRef = useRef<HTMLDivElement>(null);
  const s = useWiiSound();

  const onMove = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -8;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 8;
    if (artRef.current) artRef.current.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
  };
  const onLeave = () => {
    if (artRef.current) artRef.current.style.transform = "";
  };

  return (
    <button
      className="tile group w-[158px] cursor-pointer bg-transparent text-left transition-transform duration-200 ease-snap hover:-translate-y-1.5 active:translate-y-[-2px] active:scale-[.98]"
      style={{ perspective: 640 }}
      onPointerEnter={() => s.hover()}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onClick={() => {
        s.select();
        if (artRef.current) onOpen(item, artRef.current);
      }}
    >
      <div
        ref={artRef}
        className={`art relative aspect-[2/3] overflow-hidden rounded-tile shadow-plastic transition-shadow duration-200 [transform-style:preserve-3d] group-hover:shadow-wii-ring group-hover:animate-wiipulse ${item.posterUrl ? "bg-paper-2" : HUE_CLASS[hueFor(item.id)]}`}
      >
        {item.posterUrl ? (
          <img src={item.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <>
            <span className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[46%] bg-gradient-to-b from-white/42 via-white/8 to-transparent" />
            <Icon
              name={iconFor(item.id)}
              className="relative z-[2] h-[40%] w-[40%] text-white opacity-95 drop-shadow-[0_2px_4px_rgba(90,50,30,.22)]"
            />
          </>
        )}

        {item.badge && (
          <span className="absolute left-2 top-2 z-[3] rounded-full bg-ink/55 px-2 py-[3px] font-mono text-[9px] font-bold text-white">
            {item.badge}
          </span>
        )}
        {item.progress != null && (
          <span className="absolute inset-x-2 bottom-2 z-[3] h-1 overflow-hidden rounded-full bg-white/45">
            <b className="block h-full bg-white" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </span>
        )}
      </div>
      <div className="t-name mt-2.5 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-bold text-ink">
        {item.title}
      </div>
      <div className="t-sub mt-px font-mono text-[10px] text-ink-3">{item.subLabel}</div>
    </button>
  );
}
