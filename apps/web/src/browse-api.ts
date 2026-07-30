import type { LibrarySummary, MediaCard, MediaItemDetail } from "@hokago/contract/browse";
import { api } from "./api-client";

export type { LibrarySummary, MediaCard, MediaItemDetail };

export async function fetchLibraries(): Promise<LibrarySummary[]> {
  const { data } = await api.GET("/libraries");
  return data ?? [];
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

export async function fetchMediaItemDetail(id: string): Promise<MediaItemDetail | null> {
  const { data } = await api.GET("/media-items/{id}", { params: { path: { id } } });
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
}
