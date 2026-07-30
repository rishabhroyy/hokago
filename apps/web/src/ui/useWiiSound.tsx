// Wii-style sound layer, dependency-free. Adapt paths/naming to the repo.
// Usage:
//   <SoundProvider><App/></SoundProvider>
//   const s = useWiiSound(); s.hover(); s.select(); ...
//   const { enabled, toggle } = useSoundToggle();  // wire to the nav's <SoundToggle/>
//
// Audio can only start after a user gesture, so the context is created lazily and resumed
// on first pointerdown. All plays are no-ops when muted.

import { createContext, useContext, useMemo, useRef, useState, useEffect, type ReactNode } from "react";

type Blip = (freq: number, dur: number, type?: OscillatorType, vol?: number, glideTo?: number) => void;

interface WiiSound {
  hover: () => void;
  select: () => void;
  back: () => void;
  page: (dir: 1 | -1) => void;
  jingle: () => void;
  blip: Blip;
}

const SoundCtx = createContext<{ sound: WiiSound; enabled: boolean; toggle: () => void } | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const ctxRef = useRef<AudioContext | null>(null);
  const ac = () => {
    if (!ctxRef.current) {
      try { ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { /* noop */ }
    }
    if (ctxRef.current?.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  };

  const sound = useMemo<WiiSound>(() => {
    const blip: Blip = (freq, dur, type = "sine", vol = 0.07, glideTo) => {
      if (!enabledRef.current) return;
      const c = ac(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, c.currentTime + dur);
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + dur + 0.03);
    };
    return {
      blip,
      hover: () => blip(880, 0.055, "sine", 0.045),
      select: () => { blip(523.25, 0.09, "triangle", 0.08); setTimeout(() => blip(783.99, 0.11, "triangle", 0.07), 55); },
      back: () => blip(520, 0.12, "sine", 0.06, 300),
      page: (dir) => blip(dir > 0 ? 360 : 660, 0.2, "sine", 0.05, dir > 0 ? 680 : 340),
      jingle: () => [[523.25, 0], [659.25, 90], [783.99, 180], [1046.5, 285]].forEach(([f, t]) => setTimeout(() => blip(f, 0.3, "triangle", 0.06), t)),
    };
  }, []);

  // unlock + play the boot-ish jingle on first gesture
  useEffect(() => {
    const onFirst = () => { ac(); sound.jingle(); };
    window.addEventListener("pointerdown", onFirst, { once: true });
    return () => window.removeEventListener("pointerdown", onFirst);
  }, [sound]);

  const value = useMemo(() => ({ sound, enabled, toggle: () => setEnabled((v) => !v) }), [sound, enabled]);
  return <SoundCtx.Provider value={value}>{children}</SoundCtx.Provider>;
}

export function useWiiSound(): WiiSound {
  const ctx = useContext(SoundCtx);
  if (!ctx) throw new Error("useWiiSound must be used within <SoundProvider>");
  return ctx.sound;
}

export function useSoundToggle() {
  const ctx = useContext(SoundCtx);
  if (!ctx) throw new Error("useSoundToggle must be used within <SoundProvider>");
  return { enabled: ctx.enabled, toggle: ctx.toggle };
}
