import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Route =
  | { view: "home" }
  | { view: "library"; libraryId: string }
  | { view: "detail"; itemId: string }
  | { view: "player"; mediaFileId: string; mediaItemId: string; profileId: string };

function parse(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const q = new URLSearchParams(search);

  if (parts[0] === "library" && parts[1]) return { view: "library", libraryId: parts[1] };
  if (parts[0] === "title" && parts[1]) return { view: "detail", itemId: parts[1] };
  if (parts[0] === "watch" && parts[1]) {
    return {
      view: "player",
      mediaFileId: parts[1],
      mediaItemId: q.get("mediaItemId") ?? "",
      profileId: q.get("profileId") ?? "dev",
    };
  }
  return { view: "home" };
}

export const paths = {
  home: () => "/",
  library: (id: string) => `/library/${id}`,
  detail: (id: string) => `/title/${id}`,
  player: (mediaFileId: string, mediaItemId: string, profileId: string) =>
    `/watch/${mediaFileId}?mediaItemId=${mediaItemId}&profileId=${profileId}`,
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
