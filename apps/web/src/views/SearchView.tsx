import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSearchIndex, prefetchMediaItemDetail, type MediaCard } from "../browse-api";
import { paths, useRouter } from "../router";
import { Tile, type TileItem } from "../ui/Tile";
import { Icon } from "../ui/icons";
import { cardToTile } from "../ui/tile-mapping";
import { useStaggerEntrance } from "../ui/effects";
import { useWiiSound } from "../ui/useWiiSound";

const KIND_LABELS: Record<string, string> = {
  MOVIE: "Movies",
  SERIES: "Series",
  SEASON: "Seasons",
  EPISODE: "Episodes",
};

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function SkeletonGrid() {
  return (
    <div className="grid gap-x-[20px] gap-y-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i}>
          <div className="skeleton aspect-[2/3] rounded-[20px]" />
          <div className="skeleton mt-2.5 h-4 w-3/4 rounded-full" />
          <div className="skeleton mt-1.5 h-3 w-1/3 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function SearchView({ initialQuery }: { initialQuery: string | null }) {
  const { navigate } = useRouter();
  const s = useWiiSound();
  const [index, setIndex] = useState<MediaCard[] | null>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [kind, setKind] = useState<MediaCard["kind"] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const picksRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchSearchIndex().then(setIndex).catch(() => setIndex([]));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();

  // Keep the query shareable/refreshable without remounting on every keystroke
  // — replaceState doesn't fire popstate, so the router never re-parses.
  useEffect(() => {
    const current = new URLSearchParams(location.search).get("q") ?? "";
    const trimmed = query.trim();
    if (q !== current) history.replaceState(null, "", trimmed ? paths.search(trimmed) : paths.search());
  }, [q, query]);

  // Rank: prefix matches first, then containment — both in index order.
  const matches = useMemo(() => {
    if (!q) return [];
    const prefix: MediaCard[] = [];
    const rest: MediaCard[] = [];
    for (const item of index ?? []) {
      const t = item.title.toLowerCase();
      if (t.startsWith(q)) prefix.push(item);
      else if (t.includes(q)) rest.push(item);
    }
    return [...prefix, ...rest];
  }, [index, q]);

  const kinds = useMemo<MediaCard["kind"][]>(() => {
    const present = new Set((index ?? []).map((i) => i.kind));
    return (["MOVIE", "SERIES", "SEASON", "EPISODE"] as const).filter((k) => present.has(k));
  }, [index]);

  const results = useMemo(() => (kind ? matches.filter((i) => i.kind === kind) : matches), [matches, kind]);

  // Empty-query browse mode: shuffled suggestion chips + a shuffled shelf,
  // re-rolled only when the index arrives (never per keystroke).
  const suggestions = useMemo(() => shuffle(index ?? []).filter((i) => i.title.length <= 26).slice(0, 10), [index]);
  const picks = useMemo(() => shuffle(index ?? []).slice(0, 12), [index]);

  const tiles = useMemo(() => results.map(cardToTile), [results]);
  const picksTiles = useMemo(() => picks.map(cardToTile), [picks]);

  useStaggerEntrance(resultsRef, [tiles]);
  useStaggerEntrance(picksRef, [picksTiles]);

  const openDetail = (item: TileItem) => navigate(paths.detail(item.detailId ?? item.id));
  const prefetch = (item: TileItem) => prefetchMediaItemDetail(item.id);

  const chipCls = (active: boolean) =>
    `rounded-full px-4 py-2 text-meta font-bold transition-all duration-150 ease-snap active:scale-95 ${
      active
        ? "wii-btn text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.45),0_3px_10px_-3px_rgba(46,155,196,0.6)]"
        : "bg-paper text-ink-2 ring-1 ring-line hover:text-wii-deep hover:ring-wii/60"
    }`;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && results[0]) {
      s.select();
      navigate(paths.detail(results[0].id));
    }
    if (e.key === "Escape") {
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  return (
    <div className="min-h-screen px-12 pb-10 pt-[86px] max-[820px]:px-5">
      <div className="pb-8 pt-[30px]">
        <div className="mb-3 font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">search</div>
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-3"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search movies & series…"
            className="h-14 w-full rounded-full border-[1.5px] border-line bg-[#FBF8F1] pl-14 pr-14 text-[15px] font-semibold text-ink shadow-[inset_0_2px_4px_rgba(120,80,60,0.07)] outline-none transition-shadow duration-200 ease-smooth placeholder:font-medium placeholder:text-ink-3 focus:border-wii focus:shadow-[inset_0_2px_4px_rgba(120,80,60,0.07),0_0_0_3.5px_rgba(79,184,224,0.28)] dark:bg-[#1F1C17] dark:shadow-[inset_0_2px_4px_rgba(0,0,0,0.35)] dark:focus:shadow-[inset_0_2px_4px_rgba(0,0,0,0.35),0_0_0_3.5px_rgba(99,195,230,0.28)]"
          />
          {query && (
            <button
              className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-all duration-150 ease-snap hover:bg-wii/10 hover:text-wii-deep active:scale-90"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => {
                s.hover();
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-2.5 pl-2 font-mono text-kicker uppercase tracking-[0.1em] text-ink-3">
          ↵ opens the first result · esc clears
        </div>
      </div>

      {q ? (
        <section>
          <div className="mb-[18px] flex items-baseline gap-3.5">
            <h2 className="font-display text-title font-bold tracking-[-0.01em]">results for “{query.trim()}”</h2>
            {index && (
              <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">
                {results.length} {results.length === 1 ? "title" : "titles"}
              </span>
            )}
          </div>
          {kinds.length > 1 && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <button className={chipCls(kind === null)} onClick={() => { s.select(); setKind(null); }}>
                All
              </button>
              {kinds.map((k) => (
                <button
                  key={k}
                  className={chipCls(kind === k)}
                  onClick={() => { s.select(); setKind(kind === k ? null : k); }}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          )}
          {index === null ? (
            <SkeletonGrid />
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-[64px] text-center">
              <Icon name="sparkle" className="h-10 w-10 text-gold opacity-65" />
              <p className="mt-[14px] font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-2">
                no matches
              </p>
              <span className="mt-1 text-body text-ink-2">nothing matches “{query.trim()}” — try another title.</span>
            </div>
          ) : (
            <div
              ref={resultsRef}
              className="grid gap-x-[20px] gap-y-8"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
            >
              {tiles.map((item) => (
                <Tile key={item.id} item={item} onOpen={openDetail} onPrefetch={prefetch} />
              ))}
            </div>
          )}
        </section>
      ) : index === null ? (
        <SkeletonGrid />
      ) : index.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-[64px] text-center">
          <Icon name="search" className="h-10 w-10 text-wii opacity-70" />
          <p className="mt-[14px] font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-2">
            nothing on the shelves yet
          </p>
          <span className="mt-1 text-body text-ink-2">add a library from the admin panel and titles will show up here.</span>
        </div>
      ) : (
        <section>
          {suggestions.length > 0 && (
            <div className="mb-9">
              <div className="mb-3 font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">
                try searching
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((item) => (
                  <button
                    key={item.id}
                    className={chipCls(false)}
                    onClick={() => {
                      s.select();
                      setQuery(item.title);
                    }}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="mb-4 font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">
              you might like
            </div>
            <div
              ref={picksRef}
              className="grid gap-x-[20px] gap-y-8"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
            >
              {picksTiles.map((item) => (
                <Tile key={item.id} item={item} onOpen={openDetail} onPrefetch={prefetch} />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
