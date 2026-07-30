// Full icon set from the prototype, as a typed React component.
// <Icon name="play" style={{width:16,height:16}}/> — inherits color via currentColor.
import type { CSSProperties } from "react";

type Paths = { vb: string; body: string };

const ICONS = {
  "search": { vb: "0 0 24 24", body: `<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4.5-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  "play": { vb: "0 0 24 24", body: `<path d="M6 4l14 8-14 8V4Z" fill="currentColor"/>` },
  "pause": { vb: "0 0 24 24", body: `<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>` },
  "plus": { vb: "0 0 24 24", body: `<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  "download": { vb: "0 0 24 24", body: `<path d="M12 3v13m0 0l-5-5m5 5l5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  "star": { vb: "0 0 24 24", body: `<path d="M12 3l2.7 5.9 6.3.7-4.7 4.4 1.3 6.2L12 16.9 6.4 20.2l1.3-6.2L3 9.6l6.3-.7L12 3Z" fill="currentColor"/>` },
  "check": { vb: "0 0 24 24", body: `<path d="M4 12l6 6L20 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` },
  "back": { vb: "0 0 24 24", body: `<path d="M15 4L7 12l8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` },
  "vol": { vb: "0 0 24 24", body: `<path d="M4 9v6h4l5 4V5l-5 4H4Z" fill="currentColor"/><path d="M17 8.5a5 5 0 010 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>` },
  "mute": { vb: "0 0 24 24", body: `<path d="M4 9v6h4l5 4V5l-5 4H4Z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  "cc": { vb: "0 0 24 24", body: `<rect x="2.5" y="5" width="19" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.3c-.5-.5-1.2-.6-1.8-.3-.8.4-1.2 1.3-1.2 2.4s.4 2 1.2 2.4c.6.3 1.3.2 1.8-.3M16 10.3c-.5-.5-1.2-.6-1.8-.3-.8.4-1.2 1.3-1.2 2.4s.4 2 1.2 2.4c.6.3 1.3.2 1.8-.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>` },
  "expand": { vb: "0 0 24 24", body: `<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` },
  "list": { vb: "0 0 24 24", body: `<path d="M8 6h13M8 12h13M8 18h13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="6" r="1.4" fill="currentColor"/><circle cx="3.5" cy="12" r="1.4" fill="currentColor"/><circle cx="3.5" cy="18" r="1.4" fill="currentColor"/>` },
  "sparkle": { vb: "0 0 24 24", body: `<path d="M12 2C12 8 14 10 20 12 14 14 12 16 12 22 12 16 10 14 4 12 10 10 12 8 12 2Z" fill="currentColor"/>` },
  "window": { vb: "0 0 24 24", body: `<rect x="4" y="4" width="16" height="16" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 4v16M4 12h16" stroke="currentColor" stroke-width="1.3"/>` },
  "music": { vb: "0 0 24 24", body: `<circle cx="7" cy="18" r="2.4" fill="currentColor"/><circle cx="16" cy="16" r="2.4" fill="currentColor"/><path d="M9.4 18V6l9-2v10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>` },
  "teacup": { vb: "0 0 24 24", body: `<path d="M4 9h13v5a5 5 0 01-5 5H9a5 5 0 01-5-5V9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M17 10.5h1.5a2.2 2.2 0 010 4.4H17" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 4.5c.8.7.8 1.6 0 2.3M12 4.5c.8.7.8 1.6 0 2.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>` },
  "cherry": { vb: "0 0 24 24", body: `<path d="M4 20 14 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="15" cy="6" r="1.9" fill="currentColor"/><circle cx="18.5" cy="8.5" r="1.9" fill="currentColor"/><circle cx="17" cy="4.5" r="1.7" fill="currentColor"/><circle cx="10" cy="12" r="1.6" fill="currentColor"/>` },
  "paperplane": { vb: "0 0 24 24", body: `<path d="M3 11 20 4l-6.5 16-2.7-6.3L3 11Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10.8 13.7 20 4" stroke="currentColor" stroke-width="1.4"/>` },
  "lantern": { vb: "0 0 24 24", body: `<path d="M9.5 3.2h5M9.5 20.8h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6.5 7.5c0-1.7 2.4-2.3 5.5-2.3s5.5.6 5.5 2.3v9c0 1.7-2.4 2.3-5.5 2.3s-5.5-.6-5.5-2.3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6.9 8.4c1.7.7 8.5.7 10.2 0M6.9 15.6c1.7.7 8.5.7 10.2 0" fill="none" stroke="currentColor" stroke-width="1.4"/>` },
  "cloudsun": { vb: "0 0 24 24", body: `<circle cx="7.4" cy="6.9" r="2.5" fill="currentColor"/><path d="M7.4 1.9v1.3M2.4 6.9h1.3M3.6 3.1l.9.9M11.2 3.1l-.9.9M3.6 10.7l.9-.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.5 19a3.3 3.3 0 01.3-6.6 4.6 4.6 0 018.8 1A2.9 2.9 0 0117.6 19H9.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>` },
  "cassette": { vb: "0 0 24 24", body: `<rect x="3" y="6" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="15" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 16h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` },
  "grid": { vb: "0 0 24 24", body: `<rect x="3" y="3" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="3" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="14" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="14" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/>` },
  "users": { vb: "0 0 24 24", body: `<circle cx="9" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 20c0-3.4 2.7-6 6-6s6 2.6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17.5" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 20c.3-2.7 2-4.8 4.3-5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>` },
  "info": { vb: "0 0 24 24", body: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor"/>` },
} satisfies Record<string, Paths>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, style, className }: { name: IconName; style?: CSSProperties; className?: string }) {
  const ic = ICONS[name];
  return (
    <svg viewBox={ic.vb} className={className} style={style} aria-hidden
         dangerouslySetInnerHTML={{ __html: ic.body }} />
  );
}
