import { useCallback, useEffect, useState } from "react";
import { adminApi, fmtBytes, fmtDate, fmtNum } from "../admin-api";
import { ActionBtn, Badge, Card, Check, Empty, Field, PrimaryBtn, Table, Td, inputCls, type Toast } from "./ui";

type Library = Awaited<ReturnType<typeof adminApi.libraries>>[number];

function ScanProgress({ lib }: { lib: Library }) {
  const pct = lib.scanProgress && lib.scanProgress.totalDirs > 0 ? Math.round((lib.scanProgress.doneDirs / lib.scanProgress.totalDirs) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-kicker font-bold tabular-nums text-wii-deep">
        {lib.scanProgress?.doneDirs ?? 0} / {lib.scanProgress?.totalDirs ?? "…"}
      </span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-paper ring-1 ring-line">
        <span className="block h-full rounded-full bg-gradient-to-r from-wii-2 to-wii" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-small font-semibold text-ink-3">directories</span>
    </div>
  );
}
type LibForm = {
  name: string;
  rootPath: string;
  contentProfile: "GENERAL" | "ANIME";
  scanMode: "WATCH_AND_PERIODIC" | "PERIODIC_ONLY" | "MANUAL";
  mediaKinds: string[];
  writable: boolean;
  composeAllPosters: boolean;
  enabled: boolean;
  hiddenFromHome: boolean;
};

const emptyForm: LibForm = {
  name: "",
  rootPath: "",
  contentProfile: "GENERAL",
  scanMode: "WATCH_AND_PERIODIC",
  mediaKinds: ["MOVIE", "SERIES"],
  writable: false,
  composeAllPosters: false,
  enabled: true,
  hiddenFromHome: false,
};

export function LibrariesPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [form, setForm] = useState<LibForm>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Library | null>(null);

  const load = useCallback(() => {
    adminApi.libraries().then(setLibs).catch(() => setLibs(null));
  }, []);
  useEffect(load, [load]);
  // Poll every 3s while any library is mid-scan, so the progress bar moves.
  useEffect(() => {
    const scanning = () => libs?.some((l) => l.scanProgress != null) ?? false;
    if (!scanning()) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [libs, load]);

  const openNew = () => { setEditing(null); setForm(emptyForm); setShowForm(true); };
  const openEdit = (l: Library) => {
    setEditing(l);
    setForm({
      name: l.name,
      rootPath: l.rootPath,
      contentProfile: l.contentProfile,
      scanMode: l.scanMode,
      mediaKinds: l.mediaKinds,
      writable: l.writable,
      composeAllPosters: l.composeAllPosters,
      enabled: l.enabled,
      hiddenFromHome: l.hiddenFromHome,
    });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.rootPath.trim()) { toast("name and root path are required", true); return; }
    const body = { ...form, name: form.name.trim(), rootPath: form.rootPath.trim() };
    try {
      if (editing) {
        await adminApi.updateLibrary(editing.id, body);
        toast("library updated");
      } else {
        await adminApi.createLibrary(body);
        toast("library added — scan enqueued");
      }
      setShowForm(false);
      setEditing(null);
      load();
    } catch {
      toast("save failed — maybe that root path is already used", true);
    }
  };

  const scan = async (id: string, mode: "light" | "heavy") => {
    try { await adminApi.scanLibrary(id, mode); toast(mode === "light" ? "quick scan enqueued" : "full scan enqueued"); } catch { toast("scan failed", true); }
  };
  const del = async (l: Library) => {
    if (!confirm(`Delete library "${l.name}" and all its items? This cannot be undone.`)) return;
    try { await adminApi.deleteLibrary(l.id); toast("library deleted"); load(); } catch { toast("delete failed", true); }
  };

  const set = <K extends keyof LibForm>(k: K, v: LibForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleKind = (kind: string, on: boolean) =>
    setForm((f) => ({ ...f, mediaKinds: on ? [...f.mediaKinds, kind] : f.mediaKinds.filter((k) => k !== kind) }));

  return (
    <>
      {showForm && (
        <Card head={editing ? "Edit library" : "New library"} hint={editing ? "changes apply on save" : "a scan is enqueued automatically"}>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="name"><input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Movies" /></Field>
            <Field label="root path"><input className={inputCls} value={form.rootPath} onChange={(e) => set("rootPath", e.target.value)} placeholder="/media/movies" /></Field>
            <Field label="content profile">
              <select className={inputCls} value={form.contentProfile} onChange={(e) => set("contentProfile", e.target.value as LibForm["contentProfile"])}>
                <option>GENERAL</option><option>ANIME</option>
              </select>
            </Field>
            <Field label="scan mode">
              <select className={inputCls} value={form.scanMode} onChange={(e) => set("scanMode", e.target.value as LibForm["scanMode"])}>
                <option>WATCH_AND_PERIODIC</option><option>PERIODIC_ONLY</option><option>MANUAL</option>
              </select>
            </Field>
            <Field label="media kinds">
              <div className="flex flex-wrap gap-4">
                <Check checked={form.mediaKinds.includes("MOVIE")} onChange={(v) => toggleKind("MOVIE", v)}>movies</Check>
                <Check checked={form.mediaKinds.includes("SERIES")} onChange={(v) => toggleKind("SERIES", v)}>series</Check>
              </div>
            </Field>
            <Field label="options">
              <div className="flex flex-wrap gap-4">
                <Check checked={form.writable} onChange={(v) => set("writable", v)}>writable</Check>
                <Check checked={form.composeAllPosters} onChange={(v) => set("composeAllPosters", v)}>compose all posters</Check>
                <Check checked={form.enabled} onChange={(v) => set("enabled", v)}>enabled</Check>
                <Check checked={form.hiddenFromHome} onChange={(v) => set("hiddenFromHome", v)}>hidden from home</Check>
              </div>
            </Field>
          </div>
          <div className="mt-4 flex gap-2">
            <PrimaryBtn onClick={save}>{editing ? "Save changes" : "Add library"}</PrimaryBtn>
            <button className={inputCls + " !w-auto px-4"} onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </Card>
      )}

      <Card head="Libraries" hint={`${libs?.length ?? 0} total`} right={<ActionBtn icon="plus" onClick={openNew}>{showForm ? "Close" : "New library"}</ActionBtn>}>
        {!libs ? (
          <Empty>loading…</Empty>
        ) : libs.length === 0 ? (
          <Empty>no libraries yet — add one to start scanning.</Empty>
        ) : (
          <Table headers={["name", "root path", "items", "storage", "mode", "state", "last scan", ""]}>
            {libs.map((l) => (
              <tr key={l.id}>
                <Td>
                  <span className="font-bold text-ink">{l.name}</span>{" "}
                  <Badge tone={l.contentProfile === "ANIME" ? "gold" : "blue"}>{l.contentProfile}</Badge>
                </Td>
                <Td className="font-mono text-small text-ink-2">{l.rootPath}</Td>
                <Td className="tabular-nums">{fmtNum(l.itemCount)}</Td>
                <Td className="tabular-nums text-ink-2">{fmtBytes(l.storageBytes)}</Td>
                <Td className="font-mono text-small text-ink-2">{l.scanMode}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone={l.enabled ? "green" : "gray"}>{l.enabled ? "enabled" : "disabled"}</Badge>
                    {l.hiddenFromHome && <Badge tone="gray">hidden from home</Badge>}
                    {l.writable && <Badge tone="blue">writable</Badge>}
                  </span>
                </Td>
                <Td className="text-ink-2">
                  {l.scanProgress ? <ScanProgress lib={l} /> : fmtDate(l.lastScanAt)}
                </Td>
                <Td><span className="flex justify-end gap-1.5">
                  <ActionBtn icon="scan" onClick={() => scan(l.id, "light")}>Quick scan</ActionBtn>
                  <ActionBtn icon="scan" onClick={() => scan(l.id, "heavy")}>Full fix</ActionBtn>
                  <ActionBtn icon="edit" onClick={() => openEdit(l)}>Edit</ActionBtn>
                  <ActionBtn danger icon="trash" onClick={() => del(l)}>Delete</ActionBtn>
                </span></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}