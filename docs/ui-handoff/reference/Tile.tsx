// Exemplar poster Tile — the atom of the whole UI. Copy the *pattern* (gloss, 2:3 art,
// cursor tilt, Wii-glow, badges, progress); adapt styling to Tailwind + repo conventions.
// This file uses a bit of inline style for the tilt (which must be dynamic) and relies on
// the tokens/keyframes from design-system.md / globals.css.snippet.css.

import { useRef } from "react";
import { Icon, type IconName } from "./icons";
import { useWiiSound } from "./useWiiSound";

const HUE_BG: Record<number, string> = {
  1: "linear-gradient(160deg,#F4A98C,#EE8E6C)",
  2: "linear-gradient(160deg,#ED9DAE,#E2879A)",
  3: "linear-gradient(160deg,#EFCB79,#E4B457)",
  4: "linear-gradient(160deg,#A9CDA0,#89B683)",
  5: "linear-gradient(160deg,#9BCBE0,#78B3D0)",
  6: "linear-gradient(160deg,#F09E86,#E27862)",
};

export interface TileData {
  id: string; title: string; kind: string;
  iconName: IconName; hue: 1 | 2 | 3 | 4 | 5 | 6;
  rating?: number; badge?: string; progress?: number;
}

export function Tile({ item, onOpen }: { item: TileData; onOpen: (item: TileData, artEl: HTMLElement) => void }) {
  const artRef = useRef<HTMLDivElement>(null);
  const s = useWiiSound();

  const onMove = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -8;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 8;
    if (artRef.current) artRef.current.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
  };
  const onLeave = () => { if (artRef.current) artRef.current.style.transform = ""; };

  return (
    <button
      className="tile"
      style={{ perspective: 640, width: 158, cursor: "pointer", background: "none", textAlign: "left" }}
      onPointerEnter={() => s.hover()}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onClick={() => { s.select(); if (artRef.current) onOpen(item, artRef.current); }}
    >
      <div
        ref={artRef}
        className="art"
        style={{
          position: "relative", aspectRatio: "2 / 3", borderRadius: 16, overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: HUE_BG[item.hue], transformStyle: "preserve-3d",
          transition: "box-shadow .2s, transform .12s ease-out",
          boxShadow:
            "inset 0 1.5px 0 rgba(255,255,255,.6), inset 0 0 0 1px rgba(255,255,255,.14), 0 3px 10px -4px rgba(120,80,60,.28)",
        }}
      >
        {/* glossy top sheen */}
        <span style={{
          position: "absolute", inset: "0 0 auto 0", height: "46%", zIndex: 1, pointerEvents: "none",
          background: "linear-gradient(rgba(255,255,255,.42), rgba(255,255,255,.08) 55%, transparent)",
        }} />
        <Icon name={item.iconName} style={{ width: "40%", height: "40%", color: "#fff", opacity: .95, position: "relative", zIndex: 2,
          filter: "drop-shadow(0 2px 4px rgba(90,50,30,.22))" }} />

        {item.badge && <span className="badge">{item.badge}</span>}
        {item.rating != null && (
          <span className="rate"><Icon name="star" style={{ width: 8, height: 8, color: "#E3A34C" }} />{item.rating}</span>
        )}
        {item.progress != null && (
          <span className="prog"><b style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>
        )}
      </div>
      <div className="t-name">{item.title}</div>
      <div className="t-sub">{item.kind}</div>

      {/* CSS (Tailwind-ify): the Wii glow lives here */}
      <style>{`
        .tile:hover { transform: translateY(-6px); transition: transform .2s var(--e-snap); }
        .tile:active { transform: translateY(-2px) scale(.98); }
        .tile:hover .art { animation: wiipulse 1.3s ease-in-out infinite; }
        .badge { position:absolute; top:8px; left:8px; z-index:3; font-family:"JetBrains Mono",monospace; font-size:9px; font-weight:700; color:#fff; background:rgba(53,40,32,.55); padding:3px 8px; border-radius:100px; }
        .rate  { position:absolute; top:8px; right:8px; z-index:3; display:flex; align-items:center; gap:3px; font-family:"JetBrains Mono",monospace; font-size:9px; font-weight:700; color:#fff; background:rgba(53,40,32,.55); padding:3px 8px; border-radius:100px; }
        .prog  { position:absolute; left:8px; right:8px; bottom:8px; z-index:3; height:4px; border-radius:100px; background:rgba(255,255,255,.45); overflow:hidden; }
        .prog b{ display:block; height:100%; background:#fff; }
        .t-name{ margin-top:10px; font-size:13.5px; font-weight:700; color:#35302B; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .t-sub { font-family:"JetBrains Mono",monospace; font-size:10px; color:#B4ABA0; margin-top:1px; }
      `}</style>
    </button>
  );
}
