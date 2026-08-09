import { useEffect, useRef } from "react";
import { Icon, type IconName } from "./icons";
import { useWiiSound } from "./useWiiSound";

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
}

/**
 * Right-click menu: fixed-position popover at the cursor, clamped to the
 * viewport. A transparent backdrop underneath swallows the next click/right-
 * click (which is also how it dismisses), Escape and scroll close it too.
 * The same call is used for row tiles and detail-page episode cards.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const s = useWiiSound();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  // Clamp inside the viewport with a small margin so a menu at the bottom
  // edge doesn't open half off-screen. Height is unknown until render, so
  // measure after layout and nudge once (no re-measure loop needed).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8 || r.bottom > window.innerHeight - 8) {
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
    }
  }, [x, y]);

  return (
    <>
      <div className="fixed inset-0 z-[90]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        role="menu"
        className="fixed z-[91] min-w-[190px] rounded-[18px] border border-white bg-card/95 p-1.5 shadow-[0_18px_50px_-12px_rgba(60,40,30,0.45)] backdrop-blur-md dark:border-white/10"
        style={{ left: x, top: y }}
      >
        {items.map((item, i) => (
          <button
            key={i}
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-small font-bold text-ink transition-colors hover:bg-wii-deep/10 hover:text-wii-deep active:scale-[.98]"
            onClick={() => {
              s.select();
              item.onClick();
              onClose();
            }}
          >
            {item.icon && <Icon name={item.icon} className="h-4 w-4 text-ink-3" />}
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
