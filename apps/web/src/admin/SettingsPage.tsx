import { useEffect, useState } from "react";
import { adminApi } from "../admin-api";
import { Badge, Card, Check, Empty, Field, PrimaryBtn, Table, Td, inputCls, type Toast } from "./ui";

type Settings = Awaited<ReturnType<typeof adminApi.settings>>;
type Provider = Awaited<ReturnType<typeof adminApi.providers>>[number];

export function SettingsPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => {
    adminApi.settings().then(setSettings).catch(() => {});
    adminApi.providers().then(setProviders).catch(() => {});
  }, []);

  const save = async () => {
    if (!settings) return;
    try {
      await adminApi.updateSettings({
        basePath: settings.basePath.trim() || "/",
        maxConcurrentTranscodes: Math.max(1, Number(settings.maxConcurrentTranscodes) || 1),
        maxTranscodesPerUser: Math.max(1, Number(settings.maxTranscodesPerUser) || 1),
        fingerprintEnabled: settings.fingerprintEnabled,
        fingerprintThreads: Math.max(1, Number(settings.fingerprintThreads) || 1),
        fingerprintWindow: settings.fingerprintWindow?.trim() || null,
      });
      toast("settings saved");
    } catch { toast("save failed", true); }
  };

  const toggleProvider = async (p: Provider, enabled: boolean) => {
    try {
      await adminApi.setProvider(p.provider, enabled);
      toast(`${p.provider} ${enabled ? "enabled" : "disabled"}`);
      adminApi.providers().then(setProviders).catch(() => {});
    } catch (e) {
      toast((e as Error)?.message ?? "toggle failed", true);
    }
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => (s ? { ...s, [k]: v } : s));

  return (
    <>
      <Card head="Server" hint="applies to new transcodes">
        {!settings ? (
          <Empty>loading…</Empty>
        ) : (
          <>
            <div className="grid gap-3.5 sm:grid-cols-3">
              <Field label="base path"><input className={inputCls} value={settings.basePath} onChange={(e) => set("basePath", e.target.value)} /></Field>
              <Field label="max concurrent transcodes"><input className={inputCls} type="number" min={1} value={settings.maxConcurrentTranscodes} onChange={(e) => set("maxConcurrentTranscodes", Number(e.target.value))} /></Field>
              <Field label="max transcodes per user"><input className={inputCls} type="number" min={1} value={settings.maxTranscodesPerUser} onChange={(e) => set("maxTranscodesPerUser", Number(e.target.value))} /></Field>
              <Field label="fingerprint window (cron, off-peak)"><input className={inputCls} value={settings.fingerprintWindow ?? ""} placeholder="0 4 * * *" onChange={(e) => set("fingerprintWindow", e.target.value)} /></Field>
              <Field label="fingerprint threads"><input className={inputCls} type="number" min={1} value={settings.fingerprintThreads} onChange={(e) => set("fingerprintThreads", Number(e.target.value))} /></Field>
              <Field label="fingerprinting"><Check checked={settings.fingerprintEnabled} onChange={(v) => set("fingerprintEnabled", v)}>enabled</Check></Field>
            </div>
            <div className="mt-4"><PrimaryBtn onClick={save}>Save settings</PrimaryBtn></div>
          </>
        )}
      </Card>

      <Card head="Metadata providers" hint="keyless providers are always active — the optional tier needs a key">
        {providers.length === 0 ? (
          <Empty>loading…</Empty>
        ) : (
          <Table headers={["provider", "tier", "state", "credential", ""]}>
            {providers.map((p) => (
              <tr key={p.provider}>
                <Td className="font-mono text-small font-bold text-ink">{p.provider}</Td>
                <Td><Badge tone={p.tier === "KEYLESS" ? "blue" : "gold"}>{p.tier === "KEYLESS" ? "keyless" : "optional"}</Badge></Td>
                <Td>{p.enabled ? <Badge tone="green">active</Badge> : <Badge tone="gray">off</Badge>}</Td>
                <Td className="text-ink-2">{p.tier === "OPTIONAL" ? (p.hasSecret ? "key set" : "no key") : "no key needed"}</Td>
                <Td>
                  <span className="flex justify-end">
                    {p.tier === "OPTIONAL" ? (
                      <button className="rounded-[10px] border border-line bg-card px-3 py-1.5 text-small font-bold text-ink-2 transition hover:border-wii/50 hover:text-wii-deep active:scale-95" onClick={() => toggleProvider(p, !p.enabled)}>
                        {p.enabled ? "Disable" : "Enable"}
                      </button>
                    ) : (
                      <span className="text-small font-semibold text-ink-3">always on</span>
                    )}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}