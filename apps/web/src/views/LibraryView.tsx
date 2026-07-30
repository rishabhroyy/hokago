import { useEffect, useMemo, useRef, useState } from "react";
import { fetchLibraries, fetchLibraryItems, type LibrarySummary, type MediaCard } from "../browse-api";
import { paths, useRouter } from "../router";
import { Tile, type TileItem } from "../ui/Tile";
import { cardToTile } from "../ui/tile-mapping";
import { useWiiSound } from "../ui/useWiiSound";
import { useStaggerEntrance } from "../ui/effects";

export function LibraryView({ libraryId }: { libraryId: string }) {
  const { navigate } = useRouter();
  const s = useWiiSound();
  const [library, setLibrary] = useState<LibrarySummary | null>(null);
  const [items, setItems] = useState<MediaCard[]>([]);
  const [filter, setFilter] = useState<"ALL" | "MOVIE" | "SERIES">("ALL");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFilter("ALL");
    fetchLibraries()
      .then((libs) => setLibrary(libs.find((l) => l.id === libraryId) ?? null))
      .catch(() => {});
    fetchLibraryItems(libraryId)
      .then(setItems)
      .catch(() => {});
  }, [libraryId]);

  const kindsPresent = useMemo(() => new Set(items.map((i) => i.kind)), [items]);
  const filtered = useMemo(
    () => (filter === "ALL" ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  );

  const openDetail = (item: TileItem) => navigate(paths.detail(item.id));

  useStaggerEntrance(gridRef, [filtered]);

  const chip = (value: "ALL" | "MOVIE" | "SERIES", label: string) => (
    <button
      key={value}
      className={`rounded-full border px-[18px] py-[9px] text-[13px] font-bold transition-[transform,color,background-color,border-color] duration-150 ease-snap active:scale-95 ${
        filter === value
          ? "border-accent bg-accent text-white"
          : "border-line-2 bg-card text-ink-2 hover:border-wii hover:text-ink hover:shadow-[0_0_0_3px_rgba(79,184,224,0.25)]"
      }`}
      onClick={() => {
        s.hover();
        setFilter(value);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen overflow-y-auto px-12 pb-10 pt-[62px]">
      <div className="pb-[26px] pt-[30px]">
        <h2 className="mb-[18px] font-display text-[26px] font-bold">{library?.name ?? "Library"}</h2>
        <div className="flex flex-wrap gap-2.5">
          {chip("ALL", "All")}
          {kindsPresent.has("MOVIE") && chip("MOVIE", "Movies")}
          {kindsPresent.has("SERIES") && chip("SERIES", "Series")}
        </div>
      </div>
      <div ref={gridRef} className="grid gap-x-[18px] gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))" }}>
        {filtered.map((item) => (
          <Tile key={item.id} item={cardToTile(item)} onOpen={openDetail} />
        ))}
      </div>
    </div>
  );
}
