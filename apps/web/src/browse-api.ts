import type { LibrarySummary, MediaCard } from "@hokago/contract/browse";
import { api } from "./api-client";

export type { LibrarySummary, MediaCard };

export async function fetchLibraries(): Promise<LibrarySummary[]> {
  const { data } = await api.GET("/libraries");
  return data ?? [];
}

export async function fetchLibraryItems(id: string): Promise<MediaCard[]> {
  const { data } = await api.GET("/libraries/{id}/items", { params: { path: { id } } });
  return data ?? [];
}
