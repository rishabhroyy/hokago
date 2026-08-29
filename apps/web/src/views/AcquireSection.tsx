import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnicliDownloadInfo, AnicliSearchCandidate } from "@hokago/contract/anicli";
import { api } from "../api-client";
import { adminApi } from "../admin-api";
import { useWiiSound } from "../ui/useWiiSound";
import { Icon } from "../ui/icons";
import { HUE_CLASS, hueFor, iconFor } from "../ui/Tile";

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STATUS_LABEL: Record<AnicliDownloadInfo["status"], string> = {
  QUEUED: "queued",
  SEARCHING: "searching",
  DOWNLOADING: "downloading",
  IMPORTING: "importing",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const STATUS_TONE: Record<AnicliDownloadInfo["status"], string> = {
  QUEUED: "bg-wii/12 text-wii-deep",
  SEARCHING: "bg-wii/12 text-wii-deep",
  DOWNLOADING: "bg-wii/12 text-wii-deep",
  IMPORTING: "bg-wii/12 text-wii-deep",
  DONE: "bg-p4a/30 text-p4b",
  FAILED: "bg-accent/12 text-accent",
  CANCELLED: "bg-line text-ink-3",
};

const ACTIVE = new Set<AnicliDownloadInfo["status"]>(["QUEUED", "SEARCHING", "DOWNLOADING", "IMPORTING"]);

function Postertile({ candidate, onPick, picked }: { candidate: AnicliSearchCandidate; onPick: () => void; picked: boolean }) {
  const s = useWiiSound();
  const hue = hueFor(candidate.title + (candidate.year ?? ""));
  const icon = iconFor(candidate.title + (candidate.year ?? ""));
  const poster = candidate.posterUrl ? `/metadata/artwork-proxy?u=${encodeURIComponent(candidate.posterUrl)}` : null;
  return (
    <button
      onClick={() => {
        s.select();
        onPick();
      }}
      className={`group relative flex w-full flex-col overflow-hidden rounded-[22px] text-left transition-all duration-200 ease-snap hover:-translate-y-1 active:scale-95 ${
        picked ? "shadow-[0_0_0_2.5px_#4FB8E0,0_0_0_5px_rgba(79,184,224,0.4),0_14px_30px_-10px_rgba(120,80,60,0.5)]" : "shadow-[0_10px_26px_-14px_rgba(120,80,60,0.5)]"
      }`}
    >
      <div className={`relative aspect-[2/3] w-full ${HUE_CLASS[hue]} ${poster ? "" : "flex items-center justify-center"}`}>
        {poster ? (
          <img src={poster} alt="" className="h-full w-full object-cover transition-transform duration-300 ease-smooth group-hover:scale-[1.04]" loading="lazy" />
        ) : (
          <span className="text-white/85 drop-shadow-sm">
            <Icon name={icon} className="h-12 w-12" />
          </span>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        {candidate.year != null && (
          <span className="absolute right-2.5 top-2.5 rounded-full bg-black/40 px-2 py-0.5 font-mono text-kicker font-bold uppercase tracking-[0.1em] text-white/90 backdrop-blur-sm">
            {candidate.year}
          </span>
        )}
      </div>
      <div className="flex min-h-[44px] flex-1 items-start gap-1.5 bg-card px-3 py-2.5">
        <span className="line-clamp-2 text-meta font-bold leading-tight text-ink">{candidate.title}</span>
        {picked && <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-wii-deep" />}
      </div>
    </button>
  );
}

export function AcquireSection({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const s = useWiiSound();
  const [libs, setLibs] = useState<{ id: string; name: string }[]>([]);
  const [lib, setLib] = useState("");
  const [query, setQuery] = useState("");
  const [season, setSeason] = useState("");
  const [range, setRange] = useState("");
  const [dub, setDub] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [results, setResults] = useState<AnicliSearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<AnicliDownloadInfo[] | null>(null);

  const loadLibs = useCallback(async () => {
    const libs = await adminApi.libraries();
    setLibs(libs.filter((l) => l.contentProfile === "ANIME").map((l) => ({ id: l.id, name: l.name })));
  }, []);

  const loadRows = useCallback(async () => {
    const { data, error } = await api.GET("/anicli/downloads");
    if (error) return;
    setRows((data ?? []).map((r) => ({ ...r, createdAt: new Date(r.createdAt!), updatedAt: new Date(r.updatedAt!) })));
  }, []);

  useEffect(() => {
    void loadLibs();
    void loadRows();
    const id = setInterval(() => {
      setRows((prev) => {
        if (prev?.some((r) => ACTIVE.has(r.status))) void loadRows();
        return prev;
      });
    }, 3000);
    return () => clearInterval(id);
  }, [loadLibs, loadRows]);

  const search = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    setPicked(null);
    const { data, error } = await api.POST("/anicli/search", { body: { query: query.trim() } });
    if (error) {
      toast("search failed — is the provider reachable?", true);
    } else {
      setResults(data.candidates ?? []);
      if (data.candidates.length === 0) toast("no titles found — try a different query");
    }
    setSearching(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void search();
    if (e.key === "Escape") {
      if (query) setQuery("");
    }
  };

  const pick = (c: AnicliSearchCandidate) => {
    setQuery(c.title);
    setPicked(c.title);
    setResults([]);
  };

  const submit = async () => {
    // Season is a separate box so it survives picking a search result (which
    // resets the query to the raw AniList title) — appended onto the query
    // ani-cli/parseAnicliQuery already understands, e.g. "Frieren S2".
    const finalQuery = season.trim() ? `${query.trim()} Season ${season.trim()}` : query.trim();
    const body: Record<string, unknown> = { libraryId: lib, query: finalQuery };
    if (picked) body.title = picked;
    if (range.trim()) body.episodeRange = range.trim();
    if (dub) body.dub = true;
    const { data, error } = await api.POST("/anicli/downloads", { body: body as never });
    if (error) {
      toast((error as { error?: string }).error ?? "could not enqueue download", true);
    } else {
      toast(`queued ${data.query}`);
      setResults([]);
      setPicked(null);
      setSeason("");
      void loadRows();
    }
  };

  const cancel = async (id: string) => {
    await api.DELETE("/anicli/downloads/{id}", { params: { path: { id } } });
    void loadRows();
  };

  const canSearch = useMemo(() => query.trim().length > 0 && !searching, [query, searching]);
  const canSubmit = useMemo(() => lib && query.trim().length > 0, [lib, query]);

  const audioSeg = (active: boolean) =>
    `flex h-full items-center rounded-full px-4 text-meta font-bold transition-all duration-150 ease-snap active:scale-95 ${
      active
        ? "bg-card text-wii-deep shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_-2px_rgba(120,80,60,0.25)] ring-1 ring-line"
        : "text-ink-2 hover:text-wii-deep"
    }`;

  return (
    <section className="mb-6 rounded-[32px] bg-card p-7 shadow-panel ring-1 ring-line sm:p-9">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-section font-bold tracking-[0.01em] text-ink">Download from the internet</h2>
        <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">ani-cli · admin</span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[240px] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search for an anime"
            className="h-12 w-full rounded-full border-[1.5px] border-line bg-paper pl-11 pr-11 text-[14px] font-semibold text-ink shadow-[inset_0_2px_4px_rgba(120,80,60,0.07)] outline-none transition-shadow duration-200 ease-smooth placeholder:font-medium placeholder:text-ink-3 focus:border-wii focus:shadow-[inset_0_2px_4px_rgba(120,80,60,0.07),0_0_0_3.5px_rgba(79,184,224,0.28)]"
          />
          {query && (
            <button
              className="absolute right-2.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-all duration-150 ease-snap hover:bg-wii/10 hover:text-wii-deep active:scale-90"
              title="Clear"
              aria-label="Clear"
              onClick={() => setQuery("")}
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => void search()} disabled={!canSearch}>
          <Icon name="search" className="h-4 w-4" />
          {searching ? "searching…" : "Search"}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3 rounded-[20px] bg-paper/50 px-4 py-3 ring-1 ring-line">
        <label className="flex min-w-[180px] flex-1 flex-col gap-1.5">
          <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">save into library</span>
          <select
            className="h-11 w-full rounded-full border-[1.5px] border-line bg-card px-4 font-mono text-kicker font-bold uppercase tracking-[0.1em] text-ink outline-none transition-shadow duration-200 ease-smooth focus:border-wii focus:shadow-[0_0_0_3.5px_rgba(79,184,224,0.28)]"
            value={lib}
            onChange={(e) => setLib(e.target.value)}
          >
            <option value="">choose a library…</option>
            {libs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">audio</span>
          <div className="flex h-11 items-center rounded-full bg-paper p-1 ring-1 ring-line">
            <button type="button" className={audioSeg(!dub)} onClick={() => { s.select(); setDub(false); }}>
              subtitled
            </button>
            <button type="button" className={audioSeg(dub)} onClick={() => { s.select(); setDub(true); }}>
              dubbed
            </button>
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">season</span>
          <input
            className="h-11 w-[100px] rounded-full border-[1.5px] border-line bg-card px-4 font-mono text-kicker font-bold uppercase tracking-[0.08em] text-ink outline-none transition-shadow duration-200 ease-smooth placeholder:font-medium placeholder:tracking-[0.08em] placeholder:text-ink-3 focus:border-wii focus:shadow-[0_0_0_3.5px_rgba(79,184,224,0.28)]"
            value={season}
            onChange={(e) => setSeason(e.target.value)}
            placeholder="1"
            title="Set this when a sequel/cour has its own AniList title (e.g. K-On!!) so it files as a season of the existing show instead of a new one"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">episodes</span>
          <input
            className="h-11 w-[120px] rounded-full border-[1.5px] border-line bg-card px-4 font-mono text-kicker font-bold uppercase tracking-[0.08em] text-ink outline-none transition-shadow duration-200 ease-smooth placeholder:font-medium placeholder:tracking-[0.08em] placeholder:text-ink-3 focus:border-wii focus:shadow-[0_0_0_3.5px_rgba(79,184,224,0.28)]"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            placeholder="all"
            title="e.g. 1-12 or 5 — leave blank for every episode"
          />
        </label>

        <button className="btn btn-primary ml-auto" onClick={() => void submit()} disabled={!canSubmit}>
          <Icon name="cloudsun" className="h-4 w-4" />
          Download
        </button>
      </div>

      <div className="mt-3 pl-1 font-mono text-kicker font-medium uppercase tracking-[0.1em] text-ink-3">
        no auto-retry · stages then imports · never overwrites
      </div>

      {results.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">tap a title to pick it</div>
          <div className="grid gap-x-5 gap-y-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))" }}>
            {results.map((c) => (
              <Postertile key={c.title + (c.year ?? "")} candidate={c} picked={picked === c.title} onPick={() => pick(c)} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-7 border-t border-line pt-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">recent downloads</div>
          {rows !== null && rows.length > 0 && (
            <span className="font-mono text-kicker font-bold uppercase tracking-[0.1em] text-ink-3">{rows.length}</span>
          )}
        </div>

        {rows === null ? (
          <p className="py-4 text-meta text-ink-3">loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-4 text-meta text-ink-2">Nothing here yet — search for a title and hit Download.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const active = ACTIVE.has(r.status);
              return (
                <li key={r.id} className="flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-meta font-bold text-ink">{r.title ?? r.query}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-kicker uppercase tracking-[0.1em] text-ink-3">
                      <span className={`rounded-full px-2 py-0.5 font-bold ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                      {r.episodeRange && <span>ep {r.episodeRange}</span>}
                      {r.dub && <span>dub</span>}
                      <span>{fmtBytes(r.bytesWritten)}</span>
                      {r.progress && r.progress.files > 0 && <span>{r.progress.files} file{r.progress.files > 1 ? "s" : ""}</span>}
                    </div>
                    {r.status === "FAILED" && r.error && <div className="mt-1 truncate text-kicker text-accent">{r.error}</div>}
                    {active && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
                        <div className="h-full w-1/3 animate-[aniclipulse_1.6s_ease-in-out_infinite] rounded-full bg-wii" />
                      </div>
                    )}
                  </div>
                  {active && (
                    <button className="btn btn-ghost" onClick={() => void cancel(r.id)}>
                      Cancel
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
