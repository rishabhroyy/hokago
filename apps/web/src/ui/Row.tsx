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
}: {
  title: string;
  items: TileItem[];
  onSeeAll?: () => void;
  onOpen: (item: TileItem, artEl: HTMLElement) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const s = useWiiSound();
  useStaggerEntrance(scrollerRef, [items]);

  const scroll = (dir: 1 | -1) => {
    scrollerRef.current?.scrollBy({ left: 540 * dir, behavior: "smooth" });
    s.page(dir);
  };

  if (items.length === 0) return null;

  return (
    <div className="mt-9">
      <div className="mb-0.5 flex items-baseline justify-between px-12">
        <h3 className="relative pl-4 font-display text-[19px] font-bold before:absolute before:left-0 before:top-1/2 before:h-[19px] before:w-[5px] before:-translate-y-1/2 before:rounded-full before:bg-gradient-to-b before:from-accent before:to-accent-2">
          {title}
        </h3>
        {onSeeAll && (
          <span
            className="cursor-pointer text-[12.5px] font-bold text-ink-3 transition-colors hover:text-accent"
            onClick={onSeeAll}
          >
            See all
          </span>
        )}
      </div>
      <div className="group/row relative">
        <button
          aria-label="Scroll left"
          className="absolute left-6 top-[calc(50%-14px)] z-[5] flex h-11 w-11 items-center justify-center rounded-full border border-line-2 bg-card/95 text-ink opacity-0 shadow-[0_6px_16px_-4px_rgba(120,80,60,0.35)] backdrop-blur-sm transition-[opacity,transform,color] duration-200 ease-snap group-hover/row:opacity-100 hover:text-accent active:scale-[.88]"
          onClick={() => scroll(-1)}
        >
          <Icon name="back" className="h-[18px] w-[18px]" />
        </button>
        <div
          ref={scrollerRef}
          className="flex gap-[18px] overflow-x-auto px-12 pb-[18px] pt-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ scrollBehavior: "smooth" }}
        >
          {items.map((item) => (
            <Tile key={item.id} item={item} onOpen={onOpen} />
          ))}
        </div>
        <button
          aria-label="Scroll right"
          className="absolute right-6 top-[calc(50%-14px)] z-[5] flex h-11 w-11 items-center justify-center rounded-full border border-line-2 bg-card/95 text-ink opacity-0 shadow-[0_6px_16px_-4px_rgba(120,80,60,0.35)] backdrop-blur-sm transition-[opacity,transform,color] duration-200 ease-snap group-hover/row:opacity-100 hover:text-accent active:scale-[.88]"
          onClick={() => scroll(1)}
        >
          <Icon name="back" className="h-[18px] w-[18px] rotate-180" />
        </button>
      </div>
    </div>
  );
}
