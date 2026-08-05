import { useRef } from "react";
import { Tile, type TileItem } from "./Tile";
import { Icon } from "./icons";
import { useWiiSound } from "./useWiiSound";
import { useStaggerEntrance } from "./effects";

export function Row({
  title,
  items,
  onSeeAll,
  onOpen,
  onPrefetch,
}: {
  title: string;
  items: TileItem[];
  onSeeAll?: () => void;
  onOpen: (item: TileItem, artEl: HTMLElement) => void;
  onPrefetch?: (item: TileItem) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const s = useWiiSound();
  useStaggerEntrance(scrollerRef, [items]);

  const scroll = (dir: 1 | -1) => {
    scrollerRef.current?.scrollBy({ left: 560 * dir, behavior: "smooth" });
    s.page(dir);
  };

  if (items.length === 0) return null;

  return (
    <section className="mt-11">
      <div className="mb-1 flex items-baseline justify-between px-12 max-[820px]:px-5">
        <h3 className="relative pl-4 font-display text-section font-bold tracking-[0.01em] text-ink before:absolute before:left-0 before:top-1/2 before:h-[20px] before:w-[6px] before:-translate-y-1/2 before:rounded-full before:bg-gradient-to-b before:from-wii-2 before:to-wii-deep before:shadow-[0_0_8px_rgba(79,184,224,0.6)]">
          {title}
        </h3>
        {onSeeAll && (
          <button
            className="text-small font-bold text-ink-3 transition-colors hover:text-wii-deep"
            onClick={onSeeAll}
          >
            See all
          </button>
        )}
      </div>
      <div className="group/row relative">
        <button
          aria-label="Scroll left"
          className="absolute left-6 top-1/2 z-[5] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-card/95 text-ink dark:border-white/15 opacity-0 shadow-panel backdrop-blur-sm transition-[opacity,transform,color] duration-200 ease-snap group-hover/row:opacity-100 hover:text-wii-deep active:scale-[.88] pointer-coarse:hidden"
          onClick={() => scroll(-1)}
        >
          <Icon name="back" className="h-[18px] w-[18px]" />
        </button>
        <div
          ref={scrollerRef}
          className="flex gap-[20px] overflow-x-auto px-12 pb-[22px] pt-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[820px]:px-5"
          style={{ scrollBehavior: "smooth" }}
        >
          {items.map((item) => (
            <div key={item.id} className="w-[172px] shrink-0">
              <Tile item={item} onOpen={onOpen} onPrefetch={onPrefetch} />
            </div>
          ))}
        </div>
        <button
          aria-label="Scroll right"
          className="absolute right-6 top-1/2 z-[5] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-card/95 text-ink dark:border-white/15 opacity-0 shadow-panel backdrop-blur-sm transition-[opacity,transform,color] duration-200 ease-snap group-hover/row:opacity-100 hover:text-wii-deep active:scale-[.88] pointer-coarse:hidden"
          onClick={() => scroll(1)}
        >
          <Icon name="back" className="h-[18px] w-[18px] rotate-180" />
        </button>
      </div>
    </section>
  );
}
