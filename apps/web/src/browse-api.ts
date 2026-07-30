import type { LibrarySummary, MediaCard } from "@hokago/contract/browse";
import { api } from "./api-client";

export type { LibrarySummary, MediaCard };

export async function fetchLibraries(): Promise<LibrarySummary[]> {
  const { data } = await api.GET("/libraries");
  return data ?? [];
}

export async function fetchLibraryItems(id: string): Promise<MediaCard[]> {
  const { data } = await api.GET("/libraries/{id}/items", { params: { path: { id } } });
  // createdAt is never actually nullable — the OpenAPI generator just can't
  // see through z.coerce.date() and widens it.
  return (data ?? []).map((item) => ({ ...item, createdAt: new Date(item.createdAt!) }));
}
