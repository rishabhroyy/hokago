import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Route =
  | { view: "home" }
  | { view: "library"; libraryId: string }
  | { view: "detail"; itemId: string }
  | { view: "player"; mediaFileId: string; mediaItemId: string; profileId: string; audioStreamIndex: number | null }
  | { view: "prefs" }
  | { view: "admin" }
  | { view: "login" }
  | { view: "notfound" };

function parse(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const q = new URLSearchParams(search);

  if (parts[0] === "login") return { view: "login" };
  if (parts[0] === "admin") return { view: "admin" };
  if (parts[0] === "prefs") return { view: "prefs" };
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
  admin: () => "/admin",
  prefs: () => "/prefs",
  library: (id: string) => `/library/${id}`,
  detail: (id: string) => `/title/${id}`,
  player: (mediaFileId: string, mediaItemId: string, profileId: string, audioStreamIndex?: number | null) =>
    `/watch/${mediaFileId}?mediaItemId=${mediaItemId}&profileId=${profileId}${
      audioStreamIndex != null ? `&audio=${audioStreamIndex}` : ""
    }`,
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
