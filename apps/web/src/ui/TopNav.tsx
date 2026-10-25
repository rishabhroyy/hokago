import { useEffect, useRef, useState } from "react";
import { fetchLibraries, type LibrarySummary } from "../browse-api";
import { paths, useRouter } from "../router";
import { useIsAdmin, usePrimaryProfile } from "../profile";
import { useSoundToggle, useWiiSound } from "./useWiiSound";
import { clearAuth } from "../api-client";
import { getNativeBridge, supportsDownloads } from "@hokago/native-bridge";
import { isTvShell } from "../native";
import { Icon } from "./icons";
import { LogoMark } from "./Logo";
import { popAndPing, starShower, useKonami, useReducedMotion } from "./effects";

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
  const [navOpen, setNavOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Full-width bar: nothing behind it at the top, frosted glass once content scrolls under.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [route.view]);

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
  const tv = isTvShell();
  const downloads = !tv && supportsDownloads();

  if (route.view === "player" || route.view === "login") return null;

  const go = (path: string, e: React.MouseEvent<HTMLElement>) => {
    s.select();
    popAndPing(e.currentTarget, e.clientX, e.clientY, reduced);
    navigate(path);
  };

  // only the detail page puts artwork under the bar; there it needs a scrim to stay legible
  const overArt = route.view === "detail" && !scrolled;
  const linkCls = (active: boolean) =>
    `rounded-full px-3.5 py-[7px] text-meta font-semibold transition-[background-color,opacity,transform] active:scale-95 ${active ? "wii-btn text-white" : "opacity-70 hover:opacity-100 hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"}`;
  const iconBtn = (active: boolean) =>
    `icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full transition-[background-color,opacity,transform] duration-150 active:scale-90 hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)] ${
      active ? "text-wii opacity-100" : "opacity-80 hover:opacity-100"
    }`;

  return (
    <nav
      className={`fixed inset-x-0 top-0 z-[60] flex h-[calc(4rem+var(--hokago-safe-top))] items-center justify-between pl-[max(3rem,var(--hokago-safe-left))] pr-[max(3rem,var(--hokago-safe-right))] pt-[var(--hokago-safe-top)] transition-[background-color,box-shadow,color] duration-300 max-[820px]:pl-[max(1.25rem,var(--hokago-safe-left))] max-[820px]:pr-[max(0.75rem,var(--hokago-safe-right))] ${
        scrolled
          ? "bg-paper/70 text-ink backdrop-blur-2xl backdrop-saturate-150"
          : overArt
            ? "bg-gradient-to-b from-black/50 to-transparent text-white"
            : "text-ink"
      }`}
    >
      <div className="flex items-center gap-8">
        <button
          className="brand flex items-center gap-2 font-display text-[20px] font-bold"
          onClick={(e) => go(paths.home(), e)}
        >
          <LogoMark className="h-6 w-6" />
          hokago
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
      <div className="flex items-center gap-1">
        {/* Mobile: a hamburger reveals Home + libraries — the pill's library
            links are hidden below 820px and must stay reachable on phones. */}
        <div className="relative max-[820px]:block hidden">
          <button
            className={iconBtn(navOpen)}
            title="Libraries"
            aria-label="Libraries"
            onClick={() => setNavOpen((o) => !o)}
          >
            <Icon name="lib" className="h-[17px] w-[17px]" />
          </button>
          {navOpen && (
            <div className="panel absolute right-0 top-[48px] w-[220px] overflow-hidden rounded-panel py-1.5">
              <button
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                onClick={() => {
                  setNavOpen(false);
                  navigate(paths.home());
                }}
              >
                <Icon name="home" className="h-4 w-4" />
                Home
              </button>
              {libraries.map((lib) => (
                <button
                  key={lib.id}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                  onClick={() => {
                    setNavOpen(false);
                    navigate(paths.library(lib.id));
                  }}
                >
                  <Icon name="lib" className="h-4 w-4" />
                  {lib.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="mr-2 font-display text-meta tabular-nums opacity-60 max-[820px]:hidden">{clock}</span>
        {downloads && (
          <button
            className={iconBtn(route.view === "downloads")}
            title="Downloads"
            aria-label="Downloads"
            onClick={(e) => go(paths.downloads(), e)}
          >
            <Icon name="download" className="h-[17px] w-[17px]" />
          </button>
        )}
        {!tv && (
          <button
            className={iconBtn(route.view === "party")}
            title="Watch party"
            aria-label="Join a watch party"
            onClick={(e) => go(paths.party(), e)}
          >
            <Icon name="users" className="h-[17px] w-[17px]" />
          </button>
        )}
        {!tv && (
          <button
            className={iconBtn(route.view === "search")}
            title="Search"
            aria-label="Search"
            onClick={(e) => go(paths.search(), e)}
          >
            <Icon name="search" className="h-[17px] w-[17px]" />
          </button>
        )}
        <div ref={menuRef} className="relative">
          <button
            className="wii-btn ml-2 flex h-[34px] w-[34px] items-center justify-center overflow-hidden rounded-full font-display text-meta font-bold text-white transition-[box-shadow,transform] duration-150 hover:shadow-wii-ring active:scale-95"
            title={tv ? "Accounts" : profile?.name ?? "account"}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {!tv && profile?.avatarPath ? (
              <img src={profile.avatarPath} alt="" className="h-full w-full object-cover" />
            ) : (
              tv ? <Icon name="users" className="h-[17px] w-[17px]" /> : (profile?.name?.[0] ?? "h").toUpperCase()
            )}
          </button>
          {menuOpen && (
            <div className="panel absolute right-0 top-[48px] w-[220px] overflow-hidden rounded-panel py-1.5">
              {!tv ? (
                <>
                  <div className="flex items-center gap-2.5 border-b border-line/70 px-4 pb-2.5 pt-2">
                    {profile?.avatarPath && (
                      <img src={profile.avatarPath} alt="" className="h-6 w-6 rounded-full object-cover" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-meta font-bold text-ink">{profile?.name ?? "…"}</div>
                      <div className="text-small text-ink-3">{isAdmin ? "Admin" : "Member"}</div>
                    </div>
                  </div>
                  {/* the toggles you set once and forget live here, not in the bar */}
                  <button
                    onClick={toggle}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                  >
                    <Icon name={enabled ? "vol" : "mute"} className="h-4 w-4" />
                    {enabled ? "Sounds on" : "Sounds off"}
                  </button>
                  <div className="my-1 h-px bg-line" />
                  <button
                    onClick={() => navigate(paths.prefs())}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                  >
                    <Icon name="gear" className="h-4 w-4" />
                    Preferences
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => navigate(paths.admin())}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                    >
                      <Icon name="grid" className="h-4 w-4" />
                      Admin panel
                    </button>
                  )}
                  <button
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-accent/8 hover:text-accent"
                    onClick={() => {
                      clearAuth();
                      location.assign("/login");
                    }}
                  >
                    <Icon name="back" className="h-4 w-4 rotate-180" />
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <div className="border-b border-line/70 px-4 pb-2.5 pt-2">
                    <div className="truncate text-meta font-bold text-ink">{getNativeBridge()?.appVersion ? `app v${getNativeBridge()!.appVersion}` : "…"}</div>
                    <div className="text-kicker uppercase tracking-wider text-ink-3">this TV</div>
                  </div>
                  <button
                    onClick={() => navigate(paths.accounts())}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-meta font-medium text-ink transition-colors hover:bg-wii/8 hover:text-wii-deep"
                  >
                    <Icon name="users" className="h-4 w-4" />
                    Switch user / sign up
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
