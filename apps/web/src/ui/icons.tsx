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
  "moon": { vb: "0 0 24 24", body: `<path d="M20.2 13.4A8.2 8.2 0 0 1 10.6 3.8a8.2 8.2 0 1 0 9.6 9.6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` },
  "sun": { vb: "0 0 24 24", body: `<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9 5.5 5.5"/></g>` },
  "cc": { vb: "0 0 24 24", body: `<rect x="2.5" y="5" width="19" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.3c-.5-.5-1.2-.6-1.8-.3-.8.4-1.2 1.3-1.2 2.4s.4 2 1.2 2.4c.6.3 1.3.2 1.8-.3M16 10.3c-.5-.5-1.2-.6-1.8-.3-.8.4-1.2 1.3-1.2 2.4s.4 2 1.2 2.4c.6.3 1.3.2 1.8-.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>` },
  "expand": { vb: "0 0 24 24", body: `<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` },
  "list": { vb: "0 0 24 24", body: `<path d="M8 6h13M8 12h13M8 18h13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="6" r="1.4" fill="currentColor"/><circle cx="3.5" cy="12" r="1.4" fill="currentColor"/><circle cx="3.5" cy="18" r="1.4" fill="currentColor"/>` },
  "sparkle": { vb: "0 0 24 24", body: `<path d="M12 2C12 8 14 10 20 12 14 14 12 16 12 22 12 16 10 14 4 12 10 10 12 8 12 2Z" fill="currentColor"/>` },
  "window": { vb: "0 0 24 24", body: `<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 3.5V20.5M3.5 12H20.5"/></g><circle cx="16.3" cy="7.8" r="1.6" fill="currentColor"/>` },
  "music": { vb: "0 0 24 24", body: `<ellipse cx="8.4" cy="18.6" rx="3.3" ry="2.6" fill="currentColor"/><ellipse cx="16.6" cy="16.6" rx="3.3" ry="2.6" fill="currentColor"/><path d="M11.7 18.4V6.2M19.9 16.4V6.2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><rect x="11.7" y="4.4" width="8.2" height="1.8" rx="0.9" fill="currentColor"/>` },
  "teacup": { vb: "0 0 24 24", body: `<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 11.2c0-1.6 1.2-2.9 2.8-2.9h7.2c1.6 0 2.8 1.3 2.8 2.9v2.2c0 3.3-2.9 5.8-6.4 5.8-3.5 0-6.4-2.5-6.4-5.8Z"/><path d="M18 11.4h1.9a2 2 0 0 1 0 4.2H18"/><path d="M8.2 7.6c-.5-1 .1-1.9 1.2-2.4M13 7.6c-.5-1 .1-1.9 1.2-2.4" stroke-width="1.6"/></g><path d="M4.6 20.6h14.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>` },
  "cherry": { vb: "0 0 24 24", body: `<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12.6 3.8C11 6.4 10 9.2 9.5 12.3"/><path d="M12.6 3.8c1.1 3.4 1.2 7 1.5 10.7"/></g><circle cx="8" cy="14.5" r="2.9" fill="currentColor"/><circle cx="14.6" cy="16.8" r="2.5" fill="currentColor"/><path d="M12.8 4c1.7-.8 3.1 0 3.8 1.1-.8.8-2 1.1-3.8.6Z" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 12.6l.8-.7"/><path d="M12.9 15.2l.7-.7"/></g>` },
  "paperplane": { vb: "0 0 24 24", body: `<path d="M4.2 11.8 19.8 4.6l-6.4 9.2L19.8 18.8Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M4.2 11.8 13.4 13.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>` },
  "lantern": { vb: "0 0 24 24", body: `<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6V5.9" stroke-width="1.6"/><path d="M12 6c-4 0-5.6 2.8-5.6 6.2 0 3.4 1.6 6.2 5.6 6.2 4 0 5.6-2.8 5.6-6.2 0-3.4-1.6-6.2-5.6-6.2Z"/><path d="M12 6v12.4M6.4 12.2h11.2"/><path d="M12 18.4V20.6" stroke-width="1.6"/></g><circle cx="12" cy="21.6" r="1" fill="currentColor"/>` },
  "cloudsun": { vb: "0 0 24 24", body: `<circle cx="8.6" cy="8" r="2.9" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8.6 4V3M11.5 5.6l.8-.8M12.6 8h1M11.5 10.4l.8.8M8.6 12v1M5.7 10.4l-.8.8M4.6 8h-1M5.7 5.6l-.8-.8"/></g><path d="M16.6 20.2H8.4a4.4 4.4 0 0 1 .5-8.6 5.4 5.4 0 0 1 10.6 1.5 3.8 3.8 0 0 1-.4 7.1Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>` },
  "cassette": { vb: "0 0 24 24", body: `<rect x="3.2" y="5.5" width="17.6" height="13" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="8.2" cy="11" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.2" cy="11" r="0.8" fill="currentColor"/><circle cx="15.8" cy="11" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15.8" cy="11" r="0.8" fill="currentColor"/><path d="M6.2 16.2h11.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` },
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
