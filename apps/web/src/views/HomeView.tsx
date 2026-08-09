import { useCallback, useEffect, useMemo, useState } from "react";
import type { HomeResponse, HomeSlide } from "@hokago/contract/home";
import { api } from "../api-client";
import { fetchHome, prefetchMediaItemDetail } from "../browse-api";
import { useProfileId } from "../profile";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import type { TileItem } from "../ui/Tile";
import { Row } from "../ui/Row";
import { ContextMenu } from "../ui/ContextMenu";
import { Hero } from "../ui/Hero";
import { continueWatchingToTile, cardToTile } from "../ui/tile-mapping";

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function HomeView() {
  const { navigate } = useRouter();
  const profileId = useProfileId();
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tileMenu, setTileMenu] = useState<{ x: number; y: number; item: TileItem } | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    fetchHome(profileId)
      .then((data) => {
        if (cancelled) return;
        setHome(data);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => load(), [load]);

  // Variety: shuffle the items within every rail, and rotate the genre rails'
  // order, once per payload — the same shelf, a different arrangement each
  // visit. Keyed on `home.rows` (not `home`) so a mark-watched refetch — which
  // only swaps the continue-watching slice — never reshuffles the page. Tile
  // items are mapped INSIDE the memo so their array references stay stable
  // across unrelated re-renders (right-click menu opening/closing) — otherwise
  // Row's entrance-stagger re-runs and every poster "bounces" up again.
  const rows = useMemo(() => {
    if (!home) return [];
    const genreIds = new Set(home.rows.filter((r) => r.id.startsWith("genre:")).map((r) => r.id));
    const genreRows = shuffle(home.rows.filter((r) => genreIds.has(r.id)));
    const others = home.rows.filter((r) => !genreIds.has(r.id));
    return [...others, ...genreRows].map((r) => ({ id: r.id, title: r.title, items: shuffle(r.items).map(cardToTile) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home?.rows]);

  const slides = home?.slides ?? [];

  // Warm the detail cache for the first slide — "Details" is the most likely
  // next click once the carousel lands on it.
  const firstLocal = slides.find((s) => s.detailId);
  useEffect(() => {
    if (firstLocal?.detailId) prefetchMediaItemDetail(firstLocal.detailId, profileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstLocal?.detailId, profileId]);

  const openHeroPlay = (slide: HomeSlide) => {
    if (slide.mediaFileId && slide.mediaItemId) navigate(paths.player(slide.mediaFileId, slide.mediaItemId, profileId ?? "dev"));
  };
  const openHeroDetail = (slide: HomeSlide) => navigate(paths.detail(slide.detailId!));
  const prefetchHero = (slide: HomeSlide) => {
    if (slide.detailId) prefetchMediaItemDetail(slide.detailId, profileId);
  };

  const openDetail = (item: TileItem) => navigate(paths.detail(item.detailId ?? item.id));
  const prefetch = (item: TileItem) => prefetchMediaItemDetail(item.detailId ?? item.id, profileId);

  // Right-click mark-watched on a tile. Continue-watching reshuffles (a
  // finished episode rolls onto the next one), so only that rail is refetched
  // and swapped in place — rows/slides keep their exact arrangement, so the
  // page never visibly "refreshes" just because one poster was marked watched.
  const markTileWatched = (item: TileItem, watched: boolean) => {
    if (!profileId) return;
    api
      .POST("/watch-state/{mediaItemId}", {
        params: { path: { mediaItemId: item.id } },
        body: { profileId, watched },
      })
      .then(({ error }) => {
        if (error) throw new Error(error.error ?? "mark watched failed");
        return api.GET("/continue-watching", { params: { query: { profileId } } });
      })
      .then(({ data }) => {
        if (data) setHome((h) => (h ? { ...h, continueWatching: data } : h));
      })
      .catch((err: Error) => console.warn("mark watched failed", err.message));
  };

  const onTileMenu = (item: TileItem, x: number, y: number) => setTileMenu({ x, y, item });

  const nothingOnShelf =
    loaded && home && home.continueWatching.length === 0 && home.slides.length === 0 && home.rows.length === 0;

  if (nothingOnShelf) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="panel flex max-w-[440px] flex-col items-center rounded-[32px] p-12 text-center">
          <span className="mb-6 flex h-24 w-24 items-center justify-center rounded-[28px] bg-[linear-gradient(135deg,#45ADDD,#187AA5)] text-white shadow-btn-blue">
            <LogoMark className="h-12 w-12" />
          </span>
          <h1 className="mb-2 font-display text-title font-bold">welcome to hokago</h1>
          <p className="mb-8 text-body leading-relaxed text-ink-2">
            nothing on the menu yet — add a library from the admin panel and your channels will show up here.
          </p>
          <button className="btn btn-primary" onClick={() => navigate(paths.admin())}>
            Open admin panel
          </button>
        </div>
      </div>
    );
  }

  // Memoized so the array reference is stable across unrelated re-renders
  // (right-click menu open/close) — otherwise the row's entrance-stagger
  // re-animates and the posters "bounce" every time.
  const continueWatchingTiles = useMemo(
    () => (home?.continueWatching ?? []).map(continueWatchingToTile),
    [home?.continueWatching],
  );

  return (
    <div className="pb-6 pt-[86px]">
      {slides.length > 0 && (
        <Hero slides={slides} onPlay={openHeroPlay} onDetail={openHeroDetail} onPrefetch={prefetchHero} />
      )}

      {continueWatchingTiles.length > 0 && (
        <Row
          title="Continue watching"
          items={continueWatchingTiles}
          onOpen={openDetail}
          onPrefetch={prefetch}
          onContextMenu={onTileMenu}
        />
      )}
      {rows.map((row) => (
        <Row
          key={row.id}
          title={row.title}
          items={row.items}
          onOpen={openDetail}
          onPrefetch={prefetch}
          onContextMenu={onTileMenu}
        />
      ))}
      {tileMenu && (
        <ContextMenu
          x={tileMenu.x}
          y={tileMenu.y}
          onClose={() => setTileMenu(null)}
          items={[
            {
              label: "Mark as watched",
              icon: "check",
              onClick: () => markTileWatched(tileMenu.item, true),
            },
          ]}
        />
      )}
    </div>
  );
}
