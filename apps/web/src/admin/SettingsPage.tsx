import { useEffect, useState } from "react";
import { adminApi } from "../admin-api";
import { Card, Check, Empty, Field, PrimaryBtn, inputCls, type Toast } from "./ui";

type Settings = Awaited<ReturnType<typeof adminApi.settings>>;

export function SettingsPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    adminApi.settings().then(setSettings).catch(() => {});
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
    </>
  );
}