import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnicliDownloadInfo, AnicliSearchCandidate } from "@hokago/contract/anicli";
import { api } from "../api-client";
import { fetchLibraries } from "../browse-api";
import { useIsAdmin } from "../profile";

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STATUS_LABEL: Record<AnicliDownloadInfo["status"], string> = {
  QUEUED: "queued",
  SEARCHING: "searching…",
  DOWNLOADING: "downloading…",
  IMPORTING: "importing…",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const ACTIVE = new Set<AnicliDownloadInfo["status"]>(["QUEUED", "SEARCHING", "DOWNLOADING", "IMPORTING"]);

export function AnicliView() {
  const isAdmin = useIsAdmin();
  const [libs, setLibs] = useState<{ id: string; name: string }[]>([]);
  const [lib, setLib] = useState("");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("");
  const [dub, setDub] = useState(false);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<AnicliSearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<AnicliDownloadInfo[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadLibs = useCallback(async () => {
    const libs = await fetchLibraries();
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
    setMsg(null);
    const { data, error } = await api.POST("/anicli/search", { body: { query: query.trim() } });
    if (error) {
      setMsg({ kind: "err", text: "search failed — is the provider reachable?" });
    } else {
      setResults(data.candidates ?? []);
      if (data.candidates.length === 0) setMsg({ kind: "ok", text: "no titles found — try a different query" });
    }
    setSearching(false);
  };

  const pick = (c: AnicliSearchCandidate) => {
    setQuery(c.title);
    setTitle(c.title);
    setResults([]);
  };

  const submit = async () => {
    setMsg(null);
    const body: Record<string, unknown> = { libraryId: lib, query: query.trim() };
    if (title) body.title = title;
    if (range.trim()) body.episodeRange = range.trim();
    if (dub) body.dub = true;
    const { data, error } = await api.POST("/anicli/downloads", { body: body as never });
    if (error) {
      setMsg({ kind: "err", text: (error as { error?: string }).error ?? "could not enqueue download" });
    } else {
      setMsg({ kind: "ok", text: `queued ${data.query}` });
      setResults([]);
      void loadRows();
    }
  };

  const cancel = async (id: string) => {
    await api.DELETE("/anicli/downloads/{id}", { params: { path: { id } } });
    void loadRows();
  };

  const canSubmit = useMemo(() => lib && query.trim().length > 0, [lib, query]);

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
        <h1 className="font-display text-title font-bold">Acquire from Internet</h1>
        <p className="max-w-[420px] text-meta text-ink-2">This feature is admin-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-[900px] px-6 pb-24 pt-28">
      <div className="mb-8">
        <h1 className="font-display text-title font-bold">Acquire from Internet</h1>
        <p className="mt-1 text-meta text-ink-2">Download anime titles via ani-cli. ANIME libraries only · admin only · no auto-retry.</p>
      </div>

      {msg && (
        <p className={`mb-5 rounded-2xl px-4 py-2.5 text-small font-semibold ${msg.kind === "err" ? "bg-accent/10 text-accent" : "bg-emerald-500/10 text-emerald-600"}`}>
          {msg.text}
        </p>
      )}

      <div className="panel flex flex-wrap items-center gap-3 rounded-[22px] p-5">
        <select className="input" value={lib} onChange={(e) => setLib(e.target.value)}>
          <option value="">select ANIME library</option>
          {libs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input
          className="input min-w-[240px] flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="title, e.g. Frieren S2"
        />
        <input
          className="input w-[110px]"
          value={range}
          onChange={(e) => setRange(e.target.value)}
          placeholder="episodes"
          title="e.g. 1-12 or 5 (blank = all)"
        />
        <label className="flex items-center gap-2 text-small text-ink-2">
          <input type="checkbox" checked={dub} onChange={(e) => setDub(e.target.checked)} />
          dub
        </label>
        <button className="btn btn-ghost" onClick={() => void search()} disabled={!query.trim() || searching}>
          {searching ? "searching…" : "Search"}
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
          Download
        </button>
      </div>

      {results.length > 0 && (
        <ul className="panel mt-4 max-h-80 overflow-auto p-2">
          {results.map((c) => (
            <li key={c.title + (c.year ?? "")}>
              <button className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-accent/10" onClick={() => pick(c)}>
                <span className="truncate text-meta font-bold text-ink">{c.title}</span>
                {c.year != null && <span className="font-mono text-kicker text-ink-3">{c.year}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-3 mt-8 font-display text-subhead font-bold">Recent</h3>
      {rows === null ? (
        <p className="text-meta text-ink-3">loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-meta text-ink-2">Nothing yet — search for a title and hit Download.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id} className="panel flex items-center gap-4 rounded-[22px] px-5 py-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-paper ring-1 ring-line">
                <span className="text-kicker font-bold text-wii-deep">{r.title ?? r.query.slice(0, 2).toUpperCase()}</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-meta font-bold text-ink">{r.title ?? r.query}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-kicker uppercase tracking-[0.1em] text-ink-3">
                  <span>{STATUS_LABEL[r.status]}</span>
                  {r.episodeRange && <span>· episodes {r.episodeRange}</span>}
                  {r.dub && <span>· dub</span>}
                  <span>· {fmtBytes(r.bytesWritten)}</span>
                  {r.progress && r.progress.files > 0 && <span>· {r.progress.files} file{r.progress.files > 1 ? "s" : ""}</span>}
                </div>
                {r.status === "FAILED" && r.error && <div className="mt-1 truncate text-kicker text-accent">{r.error}</div>}
              </div>
              {(r.status === "QUEUED" || r.status === "SEARCHING" || r.status === "DOWNLOADING" || r.status === "IMPORTING") && (
                <button className="btn btn-ghost" onClick={() => void cancel(r.id)}>
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
