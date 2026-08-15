import { getNativeBridge, needsNativeUpdate, storeUrlFor, MIN_NATIVE_VERSION } from "@hokago/native-bridge";
import { platformLabel, shellPlatform } from "../native";
import type { ReactNode } from "react";

/**
 * The "Discord model" gate: the SPA is fetched fresh from the server on every
 * launch, so UI updates never need an app-store release — but a shell older
 * than the web's MIN_NATIVE_VERSION may miss native capabilities the UI now
 * depends on. Show that gate here, once, instead of failing halfway through.
 * Renders `children` unchanged when the shell is current (or absent).
 */
export function NativeUpdateGate({ children }: { children: ReactNode }) {
  const bridge = getNativeBridge();
  if (!bridge || !needsNativeUpdate(bridge.appVersion)) return <>{children}</>;
  const platform = shellPlatform() ?? "linux";
  const storeUrl = storeUrlFor(platform);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="panel flex max-w-[440px] flex-col items-center gap-5 rounded-[32px] px-12 py-10">
        <h1 className="font-display text-title font-bold">hokago app needs an update</h1>
        <p className="text-meta leading-relaxed text-ink-2">
          This version of the hokago app ({bridge.appVersion}) is too old to
          run the current hokago server UI — it needs native-level changes
          (at least v{MIN_NATIVE_VERSION}). The browser version keeps working;
          coming back from a web browser is always an option.
        </p>
        <a href={storeUrl} target="_blank" rel="noreferrer" className="btn btn-primary justify-center">
          Update in the store
        </a>
        <p className="font-mono text-kicker uppercase tracking-[0.14em] text-ink-3">
          app {bridge.appVersion} · build {bridge.appBuild} · {platformLabel(platform)}
        </p>
      </div>
    </div>
  );
}