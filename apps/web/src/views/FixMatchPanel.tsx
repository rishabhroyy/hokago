import { useEffect, useRef, useState } from "react";
import { api } from "../api-client";
import { Icon } from "../ui/icons";
import { useWiiSound } from "../ui/useWiiSound";

const PROVIDER_LABEL: Record<string, string> = {
  TVMAZE: "TVmaze",
  WIKIPEDIA: "Wikipedia",
  ANILIST: "AniList",
  MAL: "MyAnimeList",
};

interface Candidate {
  provider: "TVMAZE" | "WIKIPEDIA" | "ANILIST" | "MAL";
  providerId: string;
  title: string;
  year: number | null;
  overview?: string | null;
  artworkUrl?: string | null;
}

/**
 * The manual "fix match" flow: search the keyless metadata providers and pin
 * an identity, or unpin one and let the server re-attempt auto-resolution.
 * The pin only records the identity — a resolve job in the worker applies
 * artwork, descriptive fields and episode titles from there, so the poster
 * change lands on the next detail refetch.
 */
export function FixMatchPanel({
  itemId,
  title,
  year,
  kind,
  externalIds,
  onClose,
  onPinned,
}: {
  itemId: string;
  title: string;
  year: number | null;
  kind: "MOVIE" | "SERIES";
  externalIds: { provider: string; providerId: string }[];
  onClose: () => void;
  onPinned: () => void;
}) {
  const [query, setQuery] = useState(title);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const s = useWiiSound();

  // Debounced search on the keyless providers; year rides along only when the
  // item has one, so a folder without a year still finds its title.
  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    setFailed(false);
    setSearching(true);
    const t = setTimeout(() => {
      api
        .GET("/metadata/search", {
          params: { query: { title: query.trim(), kind, ...(year != null ? { year } : {}) } },
        })
        .then(({ data }) => {
          if (cancelled) return;
          setCandidates(data?.candidates ?? []);
          setSearching(false);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
          setSearching(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, kind, year]);

  const pin = (c: Candidate) => {
    setBusy(`${c.provider}:${c.providerId}`);
    api
      .POST("/media-items/{id}/metadata-match", {
        params: { path: { id: itemId } },
        body: { provider: c.provider, providerId: c.providerId, title: c.title, year: c.year },
      })
      .then(({ data, error }) => {
        if (error || !data) throw new Error("pin failed");
        onPinned();
        onClose();
      })
      .catch((err: Error) => {
        console.warn("pin failed", err.message);
        setBusy(null);
      });
  };

  const unpin = (provider: string) => {
    setBusy(provider);
    api
      .DELETE("/media-items/{id}/metadata-match", {
        params: { path: { id: itemId }, query: { provider } as unknown as Record<string, never> },
        // body fallback for older server, query is primary (DELETE bodies are often dropped)
        body: { provider: provider as Candidate["provider"] } as unknown as Record<string, never>,
      } as unknown as Parameters<typeof api.DELETE>[1])
      .then(({ data, error }) => {
        if (error || !data) throw new Error("unpin failed");
        onPinned();
        onClose();
      })
      .catch((err: Error) => {
        console.warn("unpin failed", err.message);
        setBusy(null);
      });
  };

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[91] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-label="Fix match"
          className="panel flex max-h-[80vh] w-full max-w-xl flex-col rounded-[30px] p-6"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-section font-black tracking-[-0.01em]">Fix match</h2>
              <p className="mt-1 text-small font-medium text-ink-3">
                Pin the right title and the server re-fetches its metadata and artwork.
              </p>
            </div>
            <button
              className="btn btn-ghost !p-2"
              aria-label="Close"
              onClick={() => {
                s.select();
                onClose();
              }}
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>

          {externalIds.length > 0 && (
            <div className="mb-4 rounded-[18px] bg-paper p-3 ring-1 ring-line">
              <p className="mb-2 font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">
                Currently matched
              </p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-small font-semibold text-ink">
                  {externalIds.map((e) => PROVIDER_LABEL[e.provider] ?? e.provider).join(" · ")}
                  <span className="ml-2 font-mono text-ink-3">({externalIds.map((e) => e.providerId).join(", ")})</span>
                </span>
                <button
                  className="rounded-full px-3 py-1 text-small font-bold text-ink-2 ring-1 ring-line transition-colors hover:text-wii-deep"
                  disabled={busy !== null}
                  onClick={() => unpin(externalIds[0]!.provider)}
                >
                  {busy === externalIds[0]!.provider ? "Removing…" : "Unmatch"}
                </button>
              </div>
            </div>
          )}

          <div className="relative mb-4">
            <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && onClose()}
              placeholder={`Search ${kind === "MOVIE" ? "AniList & MyAnimeList" : "TVmaze, AniList & MyAnimeList"}…`}
              className="w-full rounded-full border border-line bg-paper py-2.5 pl-10 pr-4 text-body font-medium text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-wii-deep/40"
              autoFocus
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {failed ? (
              <p className="py-8 text-center text-small font-medium text-ink-3">search failed — try again or rephrase</p>
            ) : searching ? (
              <p className="py-8 text-center text-small font-medium text-ink-3">searching…</p>
            ) : candidates === null || candidates.length === 0 ? (
              <p className="py-8 text-center text-small font-medium text-ink-3">
                {candidates === null ? "searching…" : "no matches — try a different search term"}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {candidates.map((c) => {
                  const key = `${c.provider}:${c.providerId}`;
                  return (
                    <li key={key}>
                      <button
                        className="flex w-full items-center gap-3 rounded-[18px] bg-paper p-2.5 text-left ring-1 ring-line transition-colors hover:bg-wii-deep/[.06] hover:ring-wii-deep/25 disabled:opacity-50"
                        disabled={busy !== null}
                        onClick={() => pin(c)}
                      >
                        {c.artworkUrl ? (
                          <img
                            // Proxied through our own origin — hotlinking the
                            // provider CDN would break under COEP require-corp
                            // (and violate the no-third-party-links rule).
                            src={`/metadata/artwork-proxy?u=${encodeURIComponent(c.artworkUrl)}`}
                            alt=""
                            loading="lazy"
                            className="h-14 w-10 shrink-0 rounded-[8px] object-cover"
                          />
                        ) : (
                          <span className="flex h-14 w-10 shrink-0 items-center justify-center rounded-[8px] bg-paper-2">
                            <Icon name="film" className="h-4 w-4 text-ink-3" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body font-bold text-ink">{c.title}</span>
                          {c.overview && (
                            <span className="mt-0.5 block truncate text-small font-medium text-ink-3">{c.overview}</span>
                          )}
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1.5">
                          <span className="rounded-full bg-card px-2.5 py-0.5 font-mono text-kicker font-bold uppercase tracking-[0.1em] text-ink-2 ring-1 ring-line">
                            {PROVIDER_LABEL[c.provider] ?? c.provider}
                          </span>
                          {c.year != null && <span className="font-mono text-kicker text-ink-3">{c.year}</span>}
                        </span>
                        {busy === key && <Icon name="refresh" className="h-4 w-4 animate-spin text-wii-deep" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}