import { useEffect, useRef, useState } from "react";
import { fetchLibraries, type LibrarySummary } from "../browse-api";
import { paths, useRouter } from "../router";
import { useIsAdmin, usePrimaryProfile } from "../profile";
import { useSoundToggle, useWiiSound } from "./useWiiSound";
import { clearAuth } from "../api-client";
import { Icon } from "./icons";
import { LogoMark } from "./Logo";
import { popAndPing, starShower, useKonami, useReducedMotion } from "./effects";
import { ThemeToggle } from "./useTheme";

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
  const profile = usePrimaryProfile();
  const isAdmin = useIsAdmin();
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchLibraries().then(setLibraries).catch(() => {});
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  useKonami(() => {
    s.jingle();
    starShower();
  });

  const reduced = useReducedMotion();

  if (route.view === "player" || route.view === "login") return null;

  const go = (path: string, e: React.MouseEvent<HTMLElement>) => {
    s.select();
    popAndPing(e.currentTarget, e.clientX, e.clientY, reduced);
    navigate(path);
  };

  const linkCls = (active: boolean) =>
    `rounded-full px-4 py-[7px] text-meta font-bold transition-all duration-150 ease-snap active:scale-95 ${
      active
        ? "wii-btn text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.45),0_3px_10px_-3px_rgba(46,155,196,0.6)]"
        : "text-ink-2 hover:bg-wii/10 hover:text-wii-deep"
    }`;

  return (
    <nav className="panel fixed inset-x-12 top-3 z-[60] flex h-[58px] items-center justify-between rounded-full pl-5 pr-3.5 max-[820px]:inset-x-3">
      <div className="flex items-center gap-7">
        <button
          className="brand relative flex items-center gap-2.5 overflow-hidden rounded-xl px-2 py-1.5 font-display text-[19px] font-bold transition-transform duration-150 ease-snap hover:scale-[1.04] active:scale-[.94]"
          onClick={(e) => go(paths.home(), e)}
        >
          <LogoMark className="h-6 w-6" />
          hokago
          <span className="pointer-events-none absolute inset-0 animate-shine bg-[linear-gradient(115deg,transparent_42%,rgba(255,255,255,0.8)_50%,transparent_58%)]" />
        </button>
        <div className="flex gap-1 max-[820px]:hidden">
          <button className={linkCls(route.view === "home")} onClick={(e) => go(paths.home(), e)}>
            Home
          </button>
          {libraries.map((lib) => (
            <button
              key={lib.id}
              className={linkCls(route.view === "library" && route.libraryId === lib.id)}
              onClick={(e) => go(paths.library(lib.id), e)}
            >
              {lib.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-small font-medium tabular-nums text-ink-3 max-[820px]:hidden">{clock}</span>
        <ThemeToggle />
        <button
          className={`icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full transition-all duration-150 ease-snap hover:bg-wii/10 active:scale-90 ${enabled ? "text-wii-deep" : "text-ink-3"}`}
          title="Sound"
          onClick={toggle}
        >
          <Icon name={enabled ? "vol" : "mute"} className="h-[17px] w-[17px]" />
        </button>
        <button
          className={`icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full transition-all duration-150 ease-snap active:scale-90 ${
            route.view === "party"
              ? "wii-btn text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.45),0_3px_10px_-3px_rgba(46,155,196,0.6)]"
              : "text-ink-2 hover:bg-wii/10 hover:text-wii-deep"
          }`}
          title="Watch party"
          aria-label="Join a watch party"
          onClick={(e) => go(paths.party(), e)}
        >
          <Icon name="users" className="h-[17px] w-[17px]" />
        </button>
        <button
          className={`icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full transition-all duration-150 ease-snap active:scale-90 ${
            route.view === "search"
              ? "wii-btn text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.45),0_3px_10px_-3px_rgba(46,155,196,0.6)]"
              : "text-ink-2 hover:bg-wii/10 hover:text-wii-deep"
          }`}
          title="Search"
          aria-label="Search"
          onClick={(e) => go(paths.search(), e)}
        >
          <Icon name="search" className="h-[17px] w-[17px]" />
        </button>
        <div ref={menuRef} className="relative">
          <button
            className="flex h-[36px] w-[36px] items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#45ADDD,#187AA5)] font-display text-card-head font-bold text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.5),0_3px_8px_-2px_rgba(46,155,196,0.55)] ring-2 ring-white/70 transition-transform duration-150 ease-snap hover:scale-105 active:scale-92"
            title={profile?.name ?? "account"}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {profile?.avatarPath ? (
              <img src={profile.avatarPath} alt="" className="h-full w-full object-cover" />
            ) : (
              (profile?.name?.[0] ?? "h").toLowerCase()
            )}
          </button>
          {menuOpen && (
            <div className="panel absolute right-0 top-[46px] w-[220px] overflow-hidden rounded-[22px] py-1.5">
              <div className="flex items-center gap-2.5 border-b border-line/70 px-4 pb-2.5 pt-2">
                {profile?.avatarPath && (
                  <img src={profile.avatarPath} alt="" className="h-6 w-6 rounded-full object-cover" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-meta font-bold text-ink">{profile?.name ?? "…"}</div>
                  <div className="font-mono text-kicker uppercase tracking-[0.12em] text-ink-3">
                    {isAdmin ? "admin" : "member"}
                  </div>
                </div>
              </div>
              <button
                onClick={() => navigate(paths.prefs())}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-bold text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
              >
                <Icon name="gear" className="h-4 w-4" />
                Preferences
              </button>
              {isAdmin && (
                <button
                  onClick={() => navigate(paths.admin())}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-bold text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                >
                  <Icon name="grid" className="h-4 w-4" />
                  Admin panel
                </button>
              )}
              <button
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-bold text-ink transition-colors hover:bg-accent/8 hover:text-accent"
                onClick={() => {
                  clearAuth();
                  location.assign("/login");
                }}
              >
                <Icon name="back" className="h-4 w-4 rotate-180" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
