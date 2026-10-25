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
        // Downloaded titles (files on the box) lead the tab; everything else
        // keeps the server's sortTitle order. Stable sort = each group's
        // internal order is untouched.
        setItems(list.sort((a, b) => Number(b.isDownloaded) - Number(a.isDownloaded)));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [libraryId]);

  const openDetail = (item: TileItem) => navigate(paths.detail(item.id));
  const prefetch = (item: TileItem) => prefetchMediaItemDetail(item.id);

  useStaggerEntrance(gridRef, [items]);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">
          {library?.name ?? "Library"}
          {items.length > 0 && <span className="count">{items.length} {items.length === 1 ? "title" : "titles"}</span>}
        </h1>
      </div>

      {loaded && items.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-[76px] pb-24 text-center">
          <Icon name="sparkle" className="h-10 w-10 text-gold opacity-65" />
          <p className="section-title mt-[14px]">Nothing on this shelf yet</p>
          <span className="mt-1 text-body text-ink-2">
            Scan a folder from the admin panel and it will appear here.
          </span>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="poster-grid"
        >
          {items.map((item) => (
            <Tile key={item.id} item={cardToTile(item)} onOpen={openDetail} onPrefetch={prefetch} />
          ))}
        </div>
      )}
    </div>
  );
}
