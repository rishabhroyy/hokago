// Living-room bokeh: soft pastel orbs drifting through the warm light above
// the living-room wallpaper. The one ambient layer you can actually SEE move
// — dust motes / channel bubbles. Canvas-2D, ~18 radial-gradient blobs,
// additive blend, dpr-capped, paused when the tab is hidden, and skipped
// entirely under prefers-reduced-motion.
import { useEffect, useRef, type RefObject } from "react";

const ORB_COLORS: Array<[number, number, number]> = [
  [103, 199, 235], // wii blue
  [240, 154, 160], // coral
  [236, 180, 118], // gold
  [166, 206, 224], // pale blue
  [250, 220, 190], // champagne
];

interface Orb {
  x: number; // 0..1 of width
  y: number; // 0..1 of height
  r: number; // px radius
  vx: number;
  vy: number;
  col: [number, number, number];
  a: number; // peak alpha
  phase: number; // per-orb sine wobble offset
}

function makeOrbs(count: number): Orb[] {
  const orbs: Orb[] = [];
  for (let i = 0; i < count; i++) {
    const col = ORB_COLORS[i % ORB_COLORS.length];
    orbs.push({
      x: Math.random(),
      y: Math.random(),
      r: 34 + Math.random() * 150,
      vx: (Math.random() - 0.5) * 0.014,
      vy: (Math.random() - 0.5) * 0.014,
      col,
      a: 0.05 + Math.random() * 0.09,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return orbs;
}

export function useLivingRoom(canvasRef: RefObject<HTMLCanvasElement | null>, orbCount = 18) {
  const pointer = useRef({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    let raf = 0;
    let running = true;
    const orbs = makeOrbs(orbCount);
    let last = performance.now();
    let t = 0;

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const onMove = (e: PointerEvent) => {
      pointer.current.x = e.clientX / w;
      pointer.current.y = e.clientY / h;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const onVisibility = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      const px = (pointer.current.x - 0.5) * w * 0.02;
      const py = (pointer.current.y - 0.5) * h * 0.02;
      for (const o of orbs) {
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        // wrap with a soft margin so orbs never visibly pop
        if (o.x < -0.15) o.x = 1.15;
        if (o.x > 1.15) o.x = -0.15;
        if (o.y < -0.15) o.y = 1.15;
        if (o.y > 1.15) o.y = -0.15;
        const wob = Math.sin(t * 0.35 + o.phase) * 0.006;
        const cx = (o.x + wob) * w - px;
        const cy = (o.y - wob * 0.7) * h - py;
        const r = o.r;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const [cr, cg, cb] = o.col;
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${o.a})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVisibility);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [orbCount]);
}