import { useEffect, useRef, useState } from "react";
import { fetchLibraries, type LibrarySummary } from "../browse-api";
import { paths, useRouter } from "../router";
import { useSoundToggle, useWiiSound } from "./useWiiSound";
import { Icon } from "./icons";
import { LogoMark } from "./Logo";
import { starShower, useKonami } from "./effects";

function useClock() {
  const [label, setLabel] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setLabel(formatClock(new Date())), 10_000);
    return () => clearInterval(id);
  }, []);
  return label;
}

function formatClock(d: Date): string {
  const ap = d.getHours() >= 12 ? "PM" : "AM";
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

export function TopNav() {
  const { route, navigate } = useRouter();
  const s = useWiiSound();
  const { enabled, toggle } = useSoundToggle();
  const clock = useClock();
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchLibraries().then(setLibraries).catch(() => {});
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  useKonami(() => {
    s.jingle();
    starShower();
  });

  if (route.view === "player") return null;

  const go = (path: string) => {
    s.select();
    navigate(path);
  };

  return (
    <nav className="fixed inset-x-0 top-0 z-[60] flex h-[62px] items-center justify-between bg-gradient-to-b from-paper/94 to-paper-2/86 px-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-md">
      <div className="flex items-center gap-9">
        <button
          className="brand relative flex items-center gap-2.5 overflow-hidden rounded-xl px-2 py-1.5 font-display text-lg font-bold transition-transform duration-150 ease-snap hover:scale-[1.04] active:scale-[.94]"
          onClick={() => go(paths.home())}
        >
          <LogoMark className="h-6 w-6" />
          hokago
          <span className="pointer-events-none absolute inset-0 animate-shine bg-[linear-gradient(115deg,transparent_42%,rgba(255,255,255,0.8)_50%,transparent_58%)]" />
        </button>
        <div className="flex gap-1.5">
          <button
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${route.view === "home" ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-ink/5 hover:text-ink"}`}
            onClick={() => go(paths.home())}
          >
            Home
          </button>
          {libraries.map((lib) => (
            <button
              key={lib.id}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${route.view === "library" && route.libraryId === lib.id ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-ink/5 hover:text-ink"}`}
              onClick={() => go(paths.library(lib.id))}
            >
              {lib.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3.5">
        <span className="font-mono text-xs font-medium text-ink-3">{clock}</span>
        <button
          className={`icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full transition-transform duration-150 ease-snap hover:bg-ink/6 active:scale-90 ${enabled ? "text-accent" : "text-ink-3"}`}
          title="Sound"
          onClick={toggle}
        >
          <Icon name={enabled ? "vol" : "mute"} className="h-[17px] w-[17px]" />
        </button>
        <div ref={searchRef} className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles..."
            className={`h-[38px] rounded-full border border-line-2 bg-card text-[13.5px] text-ink outline-none transition-[width,opacity,padding] duration-[280ms] ease-smooth ${searchOpen ? "w-[220px] px-4 opacity-100" : "w-0 px-0 opacity-0"}`}
          />
          <button
            className="icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full text-ink transition-colors hover:bg-ink/6"
            onClick={() => {
              const open = !searchOpen;
              setSearchOpen(open);
              if (open) inputRef.current?.focus();
              else setQuery("");
            }}
          >
            <Icon name="search" className="h-[17px] w-[17px]" />
          </button>
        </div>
        <div className="h-[34px] w-[34px] rounded-[10px] bg-accent shadow-[inset_0_-2px_4px_rgba(0,0,0,0.12)]" />
      </div>
    </nav>
  );
}
