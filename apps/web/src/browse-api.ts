export interface MediaCard {
  id: string;
  kind: string;
  title: string;
  sortTitle: string;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
}

export interface LibrarySummary {
  id: string;
  name: string;
  contentProfile: string;
  mediaKinds: string[];
}

function authHeaders(): HeadersInit | undefined {
  const token = localStorage.getItem("hokago_access_token");
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function fetchLibraries(): Promise<LibrarySummary[]> {
  const res = await fetch("/libraries", { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function fetchLibraryItems(id: string): Promise<MediaCard[]> {
  const res = await fetch(`/libraries/${id}/items`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}
