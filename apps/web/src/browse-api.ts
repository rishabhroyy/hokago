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
// lands on an already-rendered page instead of a skeleton ("never block").
// Keyed by profileId too — watch data (watched marks, resume positions) is
// profile-scoped, so a warm no-profile entry must not shadow the real one.
const detailCache = new Map<string, Promise<MediaItemDetail | null>>();

export function prefetchMediaItemDetail(id: string, profileId?: string | null): void {
  void fetchMediaItemDetail(id, profileId);
}

/** Drop cached detail (mark-watched mutations change episode state) — next fetch hits the API again. */
export function invalidateMediaItemDetail(id: string): void {
  detailCache.delete(`${id}:`);
  for (const key of [...detailCache.keys()]) {
    if (key.startsWith(`${id}:`)) detailCache.delete(key);
  }
}

function fetchMediaItemDetailUncached(id: string, profileId?: string | null): Promise<MediaItemDetail | null> {
  return api
    .GET("/media-items/{id}", {
      params: { path: { id }, query: profileId ? { profileId } : {} },
    })
    .then(({ data }) => {
      if (!data) return null;
      return {
        ...fixCreatedAt(data),
        children: data.children.map(fixCreatedAt),
        episodes: data.episodes.map(fixCreatedAt),
        watch: data.watch ? { ...data.watch, lastWatchedAt: data.watch.lastWatchedAt ? new Date(data.watch.lastWatchedAt) : null } : null,
        collections: data.collections.map((c) => ({
          ...c,
          entries: c.entries.map((e) => ({ ...e, item: fixCreatedAt(e.item) })),
        })),
      };
    });
}

export async function fetchMediaItemDetail(id: string, profileId?: string | null): Promise<MediaItemDetail | null> {
  const key = `${id}:${profileId ?? ""}`;
  if (!detailCache.has(key)) detailCache.set(key, fetchMediaItemDetailUncached(id, profileId));
  return detailCache.get(key)!;
}
