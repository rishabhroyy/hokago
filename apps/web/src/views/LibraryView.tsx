import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchLibraries,
  fetchLibraryItems,
  prefetchMediaItemDetail,
  type LibrarySummary,
  type MediaCard,
} from "../browse-api";
import { paths, useRouter } from "../router";
import { Tile, type TileItem } from "../ui/Tile";
import { Icon } from "../ui/icons";
import { cardToTile } from "../ui/tile-mapping";
import { useWiiSound } from "../ui/useWiiSound";
import { useStaggerEntrance } from "../ui/effects";

export function LibraryView({ libraryId }: { libraryId: string }) {
  const { navigate } = useRouter();
  const s = useWiiSound();
  const [library, setLibrary] = useState<LibrarySummary | null>(null);
  const [items, setItems] = useState<MediaCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "MOVIE" | "SERIES">("ALL");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFilter("ALL");
    setLoaded(false);
    fetchLibraries()
      .then((libs) => setLibrary(libs.find((l) => l.id === libraryId) ?? null))
      .catch(() => {});
    fetchLibraryItems(libraryId)
      .then((list) => {
        setItems(list);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [libraryId]);

  const kindsPresent = useMemo(() => new Set(items.map((i) => i.kind)), [items]);
  const filtered = useMemo(
    () => (filter === "ALL" ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  );

  const openDetail = (item: TileItem) => navigate(paths.detail(item.id));
  const prefetch = (item: TileItem) => prefetchMediaItemDetail(item.id);

  useStaggerEntrance(gridRef, [filtered]);

  const chip = (value: "ALL" | "MOVIE" | "SERIES", label: string, count: number) => (
    <button
      key={value}
      className={`flex items-center gap-2 rounded-full px-[18px] py-[9px] text-[13px] font-bold transition-all duration-150 ease-snap active:scale-95 ${
        filter === value
          ? "bg-gradient-to-b from-wii-2 to-wii text-white shadow-btn-blue"
          : "bg-white text-ink-2 shadow-panel hover:-translate-y-0.5 hover:text-wii-deep"
      }`}
      onClick={() => {
        s.hover();
        setFilter(value);
      }}
    >
      {label}
      <span
        className={`rounded-full px-1.5 font-mono text-[10px] font-bold ${filter === value ? "bg-white/25 text-white" : "bg-paper-2 text-ink-3"}`}
      >
        {count}
      </span>
    </button>
  );

  return (
    <div className="min-h-screen px-12 pb-10 pt-[86px]">
      <div className="pb-[26px] pt-[30px]">
        <div className="mb-[18px] flex items-baseline gap-3.5">
          <h2 className="font-display text-[30px] font-bold tracking-[0.005em]">{library?.name ?? "Library"}</h2>
          {items.length > 0 && (
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-ink-3">
              {filtered.length} {filtered.length === 1 ? "title" : "titles"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2.5">
          {chip("ALL", "All", items.length)}
          {kindsPresent.has("MOVIE") && chip("MOVIE", "Movies", items.filter((i) => i.kind === "MOVIE").length)}
          {kindsPresent.has("SERIES") && chip("SERIES", "Series", items.filter((i) => i.kind === "SERIES").length)}
        </div>
      </div>

      {loaded && filtered.length === 0 ? (
        <div className="panel flex flex-col items-center rounded-[28px] px-6 py-20 text-center">
          <span className="mb-5 flex h-20 w-20 items-center justify-center rounded-[24px] bg-gradient-to-br from-wii-2/40 to-wii/30 text-wii-deep">
            <Icon name="grid" className="h-8 w-8" />
          </span>
          <p className="mb-1 font-display text-[19px] font-bold text-ink">nothing on this shelf yet</p>
          <p className="text-[13px] text-ink-2">scan a folder from the admin panel and it will appear here.</p>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="grid gap-x-[20px] gap-y-8"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
        >
          {filtered.map((item) => (
            <Tile key={item.id} item={cardToTile(item)} onOpen={openDetail} onPrefetch={prefetch} />
          ))}
        </div>
      )}
    </div>
  );
}
