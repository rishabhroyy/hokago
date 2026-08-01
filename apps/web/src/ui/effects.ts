// Wii-flavored interaction effects: channel-zoom open, select-pop + star ping,
// staggered entrance, Konami code. See docs/ui-handoff/interactions.md §5,4,6,9.
import { useEffect, useRef, useState, type RefObject } from "react";

const STAR_PATH = "M12 2C12 8 14 10 20 12 14 14 12 16 12 22 12 16 10 14 4 12 10 10 12 8 12 2Z";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function spawnStar(x: number, y: number) {
  const star = document.createElement("div");
  star.style.cssText = `position:fixed;left:${x}px;top:${y}px;pointer-events:none;z-index:9999;color:#E3A34C;transform:translate(-50%,-50%) scale(.4) rotate(-8deg);transition:transform .6s cubic-bezier(.2,.7,.3,1),opacity .6s ease;opacity:1;filter:drop-shadow(0 2px 5px rgba(227,163,76,.55));`;
  star.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${STAR_PATH}"/></svg>`;
  document.body.appendChild(star);
  requestAnimationFrame(() => {
    star.style.transform = `translate(-50%,-150%) scale(1.2) rotate(34deg)`;
    star.style.opacity = "0";
  });
  setTimeout(() => star.remove(), 650);
}

/** §4 — springy pop on the clicked element + a small gold star ping at the pointer. */
export function popAndPing(el: HTMLElement, clientX: number, clientY: number, reduced: boolean) {
  if (reduced) return;
  el.style.animation = "popsel .34s cubic-bezier(.4,1.4,.5,1)";
  const onEnd = () => {
    el.style.animation = "";
    el.removeEventListener("animationend", onEnd);
  };
  el.addEventListener("animationend", onEnd);
  spawnStar(clientX, clientY);
}

/** §5 — the signature Wii "channel opens" poster → detail transition. */
export function zoomOpen(artEl: HTMLElement, navigate: () => void, reduced: boolean) {
  if (reduced) {
    navigate();
    return;
  }
  try {
    const r = artEl.getBoundingClientRect();
    const cs = getComputedStyle(artEl);
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background-image:${cs.backgroundImage};background-color:${cs.backgroundColor};border-radius:${cs.borderRadius};box-shadow:0 0 0 3px rgba(255,255,255,.9),0 0 40px 10px rgba(120,170,255,.55);z-index:9999;transition:left .42s cubic-bezier(.4,0,.2,1),top .42s cubic-bezier(.4,0,.2,1),width .42s cubic-bezier(.4,0,.2,1),height .42s cubic-bezier(.4,0,.2,1),border-radius .42s cubic-bezier(.4,0,.2,1),opacity .3s ease .42s;`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.style.left = "0";
      overlay.style.top = "0";
      overlay.style.width = "100vw";
      overlay.style.height = "100vh";
      overlay.style.borderRadius = "0";
    });
    // Navigate almost immediately — the fixed overlay covers the swap, and the
    // detail fetch (already warmed by hover prefetch) runs during the zoom
    // instead of after it. Waiting for the full animation first doubled the
    // perceived load time of every title page.
    setTimeout(navigate, 90);
    setTimeout(() => {
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 320);
    }, 420);
  } catch {
    navigate();
  }
}

/** §6 — riseIn tiles/cards in a container with incremental delay, once per `deps` change. */
export function useStaggerEntrance(containerRef: RefObject<HTMLElement | null>, deps: readonly unknown[]) {
  const reduced = useReducedMotion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (reduced || !containerRef.current) return;
    const children = Array.from(containerRef.current.children) as HTMLElement[];
    const cleanups: Array<() => void> = [];
    children.forEach((el, i) => {
      const delay = Math.min(i * 0.035, 0.5);
      el.style.animation = `riseIn .5s cubic-bezier(.4,0,.2,1) ${delay}s both`;
      const onEnd = () => {
        el.style.animation = "";
      };
      el.addEventListener("animationend", onEnd, { once: true });
      cleanups.push(() => el.removeEventListener("animationend", onEnd));
    });
    return () => cleanups.forEach((c) => c());
  }, deps);
}

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

/** §9 — Konami code easter egg: jingle + a shower of star pings. */
export function useKonami(onTrigger: () => void) {
  const posRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const expected = KONAMI[posRef.current];
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === expected) {
        posRef.current += 1;
        if (posRef.current === KONAMI.length) {
          posRef.current = 0;
          onTrigger();
        }
      } else {
        posRef.current = key === KONAMI[0] ? 1 : 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTrigger]);
}

export function starShower(count = 22) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => spawnStar(Math.random() * innerWidth, Math.random() * innerHeight), i * 25);
  }
}
