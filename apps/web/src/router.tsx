import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Route =
  | { view: "home" }
  | { view: "library"; libraryId: string }
  | { view: "detail"; itemId: string }
  | { view: "player"; mediaFileId: string; mediaItemId: string; profileId: string; audioStreamIndex: number | null }
  | { view: "party"; code: string | null }
  | { view: "prefs" }
  | { view: "pair" }
  | { view: "accounts" }
  | { view: "downloads" }
  | { view: "anicli" }
  | { view: "offline" }
  | { view: "offlineWatch"; downloadId: string; profileId: string }
  | { view: "search"; q: string | null }
  | { view: "admin" }
  | { view: "login" }
  | { view: "setup" }
  | { view: "notfound" };

function parse(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const q = new URLSearchParams(search);

  if (parts[0] === "login") return { view: "login" };
  if (parts[0] === "setup") return { view: "setup" };
  if (parts[0] === "admin") return { view: "admin" };
  if (parts[0] === "prefs") return { view: "prefs" };
  if (parts[0] === "pair") return { view: "pair" };
  if (parts[0] === "accounts") return { view: "accounts" };
  if (parts[0] === "downloads") return { view: "downloads" };
  if (parts[0] === "anicli") return { view: "anicli" };
  if (parts[0] === "offline" && parts[1] === "watch" && parts[2]) {
    return { view: "offlineWatch", downloadId: parts[2], profileId: q.get("profileId") ?? "dev" };
  }
  if (parts[0] === "offline") return { view: "offline" };
  if (parts[0] === "search") return { view: "search", q: q.get("q") };
  if (parts[0] === "party" && !parts[1]) return { view: "party", code: null };
  if (parts[0] === "party" && parts[1]) return { view: "party", code: parts[1] };
  if (parts[0] === "library" && parts[1]) return { view: "library", libraryId: parts[1] };
  if (parts[0] === "title" && parts[1]) return { view: "detail", itemId: parts[1] };
  if (parts[0] === "watch" && parts[1]) {
    const audio = q.get("audio");
    return {
      view: "player",
      mediaFileId: parts[1],
      mediaItemId: q.get("mediaItemId") ?? "",
      profileId: q.get("profileId") ?? "dev",
      audioStreamIndex: audio !== null ? Number(audio) : null,
    };
  }
  if (parts.length === 0) return { view: "home" };
  return { view: "notfound" };
}

export const paths = {
  home: () => "/",
  login: () => "/login",
  setup: () => "/setup",
  admin: () => "/admin",
  prefs: () => "/prefs",
  pair: () => "/pair",
  accounts: () => "/accounts",
  downloads: () => "/downloads",
  anicli: () => "/anicli",
  offline: () => "/offline",
  offlineWatch: (downloadId: string, profileId: string) => `/offline/watch/${downloadId}?profileId=${profileId}`,
  search: (query?: string) => (query ? `/search?q=${encodeURIComponent(query)}` : "/search"),
  library: (id: string) => `/library/${id}`,
  detail: (id: string) => `/title/${id}`,
  party: (code?: string | null) => (code ? `/party/${encodeURIComponent(code)}` : "/party"),
  player: (mediaFileId: string, mediaItemId: string, profileId: string, audioStreamIndex?: number | null, partyId?: string | null) =>
    `/watch/${mediaFileId}?mediaItemId=${mediaItemId}&profileId=${profileId}${
      audioStreamIndex != null ? `&audio=${audioStreamIndex}` : ""
    }${partyId ? `&party=${partyId}` : ""}`,
};

const RouterCtx = createContext<{ route: Route; navigate: (path: string) => void } | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname, location.search));

  useEffect(() => {
    const onPop = () => setRoute(parse(location.pathname, location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    history.pushState(null, "", path);
    setRoute(parse(location.pathname, location.search));
  }, []);

  const value = useMemo(() => ({ route, navigate }), [route, navigate]);
  return <RouterCtx.Provider value={value}>{children}</RouterCtx.Provider>;
}

export function useRouter() {
  const ctx = useContext(RouterCtx);
  if (!ctx) throw new Error("useRouter must be used within <RouterProvider>");
  return ctx;
}
