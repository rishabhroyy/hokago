import { useEffect, useRef, useState } from "react";
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
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  const openDetail = (item: TileItem) => navigate(paths.detail(item.id));
  const prefetch = (item: TileItem) => prefetchMediaItemDetail(item.id);

  useStaggerEntrance(gridRef, [items]);

  return (
    <div className="min-h-screen px-12 pb-10 pt-[86px] max-[820px]:px-5">
      <div className="pb-[26px] pt-[30px]">
        <div className="mb-[18px] flex items-baseline gap-3.5">
          <h2 className="font-display text-title font-bold tracking-[-0.01em]">{library?.name ?? "Library"}</h2>
          {items.length > 0 && (
            <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">
              {items.length} {items.length === 1 ? "title" : "titles"}
            </span>
          )}
        </div>
      </div>

      {loaded && items.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-[76px] pb-24 text-center">
          <Icon name="sparkle" className="h-10 w-10 text-gold opacity-65" />
          <p className="mt-[14px] font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-2">
            nothing on this shelf yet
          </p>
          <span className="mt-1 text-body text-ink-2">
            scan a folder from the admin panel and it will appear here.
          </span>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="grid gap-x-[20px] gap-y-8"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
        >
          {items.map((item) => (
            <Tile key={item.id} item={cardToTile(item)} onOpen={openDetail} onPrefetch={prefetch} />
          ))}
        </div>
      )}
    </div>
  );
}
