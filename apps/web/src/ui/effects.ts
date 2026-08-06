// Wii-flavored interaction effects: channel-zoom open, select-pop + star ping,
// staggered entrance, Konami code.
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

/** Springy pop on the clicked element + a small gold star ping at the pointer. */
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

/**
 * Sample a show's poster into one soft, wii-channel-ish color for the window.
 * The poster itself is a tiny thumbnail — projecting it fullscreen looks
 * blurry, so the channel opens as a solid color drawn from the artwork
 * instead. Falls back to the tile's background, then a warm pastel pair.
 */
function channelColor(artEl: HTMLElement): string {
  try {
    const img = artEl.querySelector("img");
    if (img) {
      const c = document.createElement("canvas");
      c.width = c.height = 16;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          n += 1;
        }
        if (n > 0) {
          const lighten = (v: number) => Math.round(v / n + (255 - v / n) * 0.22);
          return `rgb(${lighten(r)},${lighten(g)},${lighten(b)})`;
        }
      }
    }
  } catch {
    // fall through to the background color
  }
  const bg = getComputedStyle(artEl).backgroundColor;
  if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  return "rgb(222,170,120)";
}

/** the signature Wii "channel opens" poster → detail transition. */
export function zoomOpen(artEl: HTMLElement, navigate: () => void, reduced: boolean) {
  if (reduced) {
    navigate();
    return;
  }
  try {
    const r = artEl.getBoundingClientRect();
    const borderRadius = getComputedStyle(artEl).borderRadius;
    const overlay = document.createElement("div");
    overlay.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:${borderRadius};` +
      `box-shadow:0 0 0 3px rgba(255,255,255,.85),0 0 44px 14px rgba(255,255,255,.3);` +
      "z-index:9999;overflow:hidden;pointer-events:none;";
    overlay.style.background = channelColor(artEl);
    // a diagonal sheen gives the flat color depth without any image pixels
    const sheen = document.createElement("div");
    sheen.style.cssText =
      "position:absolute;inset:0;pointer-events:none;" +
      "background:linear-gradient(155deg,rgba(255,255,255,.34) 0%,rgba(255,255,255,.08) 34%,rgba(255,255,255,0) 55%,rgba(0,0,0,.16) 100%);";
    overlay.appendChild(sheen);
    // the wii gloss: a skewed white band sweeps across while the channel opens
    const shine = document.createElement("div");
    shine.style.cssText =
      "position:absolute;top:-30%;left:-60%;width:38%;height:160%;transform:skewX(-18deg);pointer-events:none;" +
      "background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.85) 50%,rgba(255,255,255,0) 100%);";
    overlay.appendChild(shine);
    document.body.appendChild(overlay);

    // Web Animations API — CSS transitions can't reliably start when the
    // element and its end styles land in the same frame (the browser paints
    // only the end state, so the zoom never visibly animates). WAAPI plays
    // over real time regardless. The overshoot easing is the wii "pop".
    overlay.animate(
      [
        { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius },
        { left: "0px", top: "0px", width: "100vw", height: "100vh", borderRadius: "18px" },
      ],
      { duration: 460, easing: "cubic-bezier(.3,1.45,.45,1)", fill: "both" },
    );
    shine.animate([{ left: "-60%" }, { left: "135%" }], {
      duration: 620,
      easing: "cubic-bezier(.4,0,.2,1)",
      delay: 40,
      fill: "both",
    });

    // Navigate almost immediately — the fixed overlay covers the swap, and the
    // detail fetch (already warmed by hover prefetch) runs during the zoom
    // instead of after it. Waiting for the full animation first doubled the
    // perceived load time of every title page.
    setTimeout(navigate, 90);

    // Shutter reveal: the fullscreen channel splits into two halves that
    // slide apart like a Wii window, showing the page underneath. Wait past
    // the zoom's overshoot tail (460ms) so the halves clone at the exact
    // settled 100vw geometry and the seam lands dead-center.
    setTimeout(() => {
      overlay.style.left = "0px";
      overlay.style.top = "0px";
      overlay.style.width = "100vw";
      overlay.style.height = "100vh";
      overlay.style.borderRadius = "18px";
      const full = overlay.getBoundingClientRect();
      const halves: Array<[string, string]> = [
        ["inset(0 0 50% 0)", "-100%"],
        ["inset(50% 0 0 0)", "100%"],
      ];
      for (const [inset, ty] of halves) {
        const half = overlay.cloneNode(true) as HTMLElement;
        half.style.cssText =
          `position:fixed;left:${full.left}px;top:${full.top}px;width:${full.width}px;height:${full.height}px;` +
          `z-index:9999;overflow:hidden;pointer-events:none;clip-path:${inset};`;
        document.body.appendChild(half);
        half.animate([{ transform: "translateY(0)" }, { transform: `translateY(${ty})` }], {
          duration: 340,
          easing: "cubic-bezier(.4,0,.2,1)",
          fill: "both",
        });
        setTimeout(() => half.remove(), 420);
      }
      overlay.remove();
    }, 500);
  } catch {
    navigate();
  }
}

/** riseIn tiles/cards in a container with incremental delay, once per `deps` change. */
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

/** Konami code easter egg: jingle + a shower of star pings. */
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
