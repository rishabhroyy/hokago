/**
 * D-pad / remote navigation for TV shells (Android TV, Google TV). The whole
 * web UI is built for mouse; in a TV shell we map arrow keys onto
 * focus-based movement over the page's real focusables (buttons, links,
 * inputs), Enter/Space clicks, and the hardware back button pushes history
 * back. Zero changes to individual views.
 */
import { useEffect } from "react";
import { isTvShell } from "@hokago/native-bridge";

const FOCUSABLE =
  'a[href], button:not([disabled]), [role="button"], [tabindex]:not([tabindex="-1"]), input:not([type="hidden"]), select, textarea';

function visibleFocusables(): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));
  return all.filter((el) => {
    if (el.closest("[hidden]") || (el as HTMLElement).hidden) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  });
}

function center(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Nearest focusable in the given direction, weighted toward on-axis picks. */
function nearest(focusables: HTMLElement[], current: HTMLElement, dir: "up" | "down" | "left" | "right"): HTMLElement | null {
  const cur = center(current.getBoundingClientRect());
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of focusables) {
    if (el === current) continue;
    const c = center(el.getBoundingClientRect());
    const dx = c.x - cur.x;
    const dy = c.y - cur.y;
    const offAxis = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const onAxis = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    if (onAxis <= 0) continue; // must move in the requested direction
    const reach = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    // Strongly prefer on-axis (row/column) neighbors.
    const score = reach * 1.6 + onAxis + offAxis * 0.4;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function useTvKeyboardNav(): void {
  useEffect(() => {
    if (!isTvShell()) return;

    const focusFirst = () => {
      const els = visibleFocusables();
      if (els.length > 0 && document.activeElement === document.body) els[0].focus({ preventScroll: true });
    };
    // Refocus onto the page's first control after any route change.
    const onRoute = () => requestAnimationFrame(focusFirst);
    window.addEventListener("popstate", onRoute);

    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
      ) {
        return; // let text entry own the keys
      }
      // Playback owns the remote while a video is running.
      const video = document.querySelector("video");
      if (video && !video.paused) return;

      const dir = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
      if (dir) {
        e.preventDefault();
        const els = visibleFocusables();
        const active = el && els.includes(el) ? el : document.activeElement as HTMLElement | null;
        const from = active && els.includes(active) ? active : null;
        if (!from) {
          focusFirst();
        } else {
          const target = nearest(els, from, dir);
          target?.focus({ preventScroll: true });
          target?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.click();
      }
    };
    window.addEventListener("keydown", onKey);

    // The shell's hardware back button (Android TV) arrives as a native
    // event; push history back like browser back.
    const onNative = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === "back" && location.pathname !== "/" && location.pathname !== "/accounts") {
        window.history.back();
      }
    };
    window.addEventListener("hokago-native", onNative);

    return () => {
      window.removeEventListener("popstate", onRoute);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hokago-native", onNative);
    };
  }, []);
}