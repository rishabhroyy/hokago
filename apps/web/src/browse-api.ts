import type { LibrarySummary, MediaCard, MediaItemDetail } from "@hokago/contract/browse";
import { api } from "./api-client";

export type { LibrarySummary, MediaCard, MediaItemDetail };

// Libraries change only via admin action — one in-flight promise per session
// is fine, and it keeps TopNav/Home/Library from triple-fetching on mount.
let librariesPromise: Promise<LibrarySummary[]> | null = null;

export function fetchLibraries(): Promise<LibrarySummary[]> {
  if (!librariesPromise) {
    librariesPromise = api.GET("/libraries").then(({ data }) => data ?? []);
  }
  return librariesPromise;
}

// createdAt is never actually nullable — the OpenAPI generator just can't
// see through z.coerce.date() and widens it.
function fixCreatedAt<T extends { createdAt: string | null }>(item: T): Omit<T, "createdAt"> & { createdAt: Date } {
  return { ...item, createdAt: new Date(item.createdAt!) };
}

export async function fetchLibraryItems(id: string): Promise<MediaCard[]> {
  const { data } = await api.GET("/libraries/{id}/items", { params: { path: { id } } });
  return (data ?? []).map(fixCreatedAt);
}

// Detail prefetch cache: tiles warm it on pointer-enter so the channel-zoom
// lands on an already-rendered page instead of a skeleton (§9 "never block").
const detailCache = new Map<string, Promise<MediaItemDetail | null>>();

export function prefetchMediaItemDetail(id: string): void {
  void fetchMediaItemDetail(id);
}

function fetchMediaItemDetailUncached(id: string): Promise<MediaItemDetail | null> {
  return api.GET("/media-items/{id}", { params: { path: { id } } }).then(({ data }) => {
    if (!data) return null;
    return {
      ...fixCreatedAt(data),
      children: data.children.map(fixCreatedAt),
      episodes: data.episodes.map(fixCreatedAt),
      collections: data.collections.map((c) => ({
        ...c,
        entries: c.entries.map((e) => ({ ...e, item: fixCreatedAt(e.item) })),
      })),
    };
  });
}

export async function fetchMediaItemDetail(id: string): Promise<MediaItemDetail | null> {
  if (!detailCache.has(id)) detailCache.set(id, fetchMediaItemDetailUncached(id));
  return detailCache.get(id)!;
}
