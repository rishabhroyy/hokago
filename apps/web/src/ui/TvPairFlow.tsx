import { useEffect, useRef, useState } from "react";
import { getNativeBridge } from "@hokago/native-bridge";
import { api, storeAuthResult } from "../api-client";
import { loginPlatform, platformLabel, shellPlatform } from "../native";
import { useWiiSound } from "./useWiiSound";
import { Icon } from "./icons";

const POLL_MS = 3500;

/**
 * The TV side of the pairing flow — displayed on screen, approved on a
 * phone/PC at <server>/pair. Lives entirely in the web app so the TV shell
 * stays a plain webview.
 */
export function TvPairFlow({ onComplete }: { onComplete?: () => void }) {
  const s = useWiiSound();
  const [code, setCode] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const platform = shellPlatform();

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const requestCode = async () => {
    if (busy) return;
    setBusy(true);
    setExpired(false);
    try {
      const { data, error } = await api.POST("/auth/pair/request", {
        body: {
          name: `Hokago ${platform ? platformLabel(platform) : "TV"}`,
          platform: loginPlatform() ?? "ANDROIDTV",
          clientKey: getNativeBridge()?.clientKey,
        },
      });
      if (error || !data) throw new Error(error?.error ?? "could not start pairing");
      setCode(data.code);
      setDeadline(data.expiresAt ? new Date(data.expiresAt).getTime() : null);
      startPolling(data.pairingId);
    } catch (err) {
      setCode(null);
      setExpired(false);
      setDeadline(null);
      alert(err instanceof Error ? err.message : "could not start pairing — check the server URL");
    } finally {
      setBusy(false);
    }
  };

  const startPolling = (id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const { data } = await api.POST("/auth/pair/status", { body: { pairingId: id } });
      if (!data) return;
      if (data.status === "COMPLETE" && data.accessToken && data.refreshToken) {
        stopPolling();
        storeAuthResult({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          sessionId: data.sessionId ?? "",
          deviceId: data.deviceId ?? null,
          username: data.username,
        });
        s.jingle();
        onComplete?.();
        location.assign("/");
      } else if (data.status === "EXPIRED") {
        stopPolling();
        setExpired(true);
      }
    }, POLL_MS);
  };

  useEffect(() => {
    mountedRef.current = true;
    void requestCode();
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (deadline == null) return;
    const id = setInterval(() => {
      if (deadline - Date.now() <= 0) {
        clearInterval(id);
        stopPolling();
        setExpired(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const secondsLeft = deadline != null ? Math.max(0, Math.round((deadline - Date.now()) / 1000)) : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="panel flex flex-col items-center rounded-[32px] px-14 py-12">
        <h1 className="font-display text-title font-bold">Sign in with a code</h1>
        <p className="mt-2 max-w-[420px] text-meta text-ink-2">
          Open <span className="font-mono font-bold text-wii-deep">/pair</span> on your phone or
          computer, sign in, and enter this code:
        </p>
        {code ? (
          <div className="mt-8 flex gap-4" data-focusable>
            {code.split("").map((d, i) => (
              <span
                key={i}
                className="flex h-[74px] w-[52px] items-center justify-center rounded-[14px] bg-paper font-mono text-[42px] font-bold tabular-nums text-ink ring-1 ring-line"
              >
                {d}
              </span>
            ))}
          </div>
        ) : busy ? (
          <div className="mt-8 text-meta text-ink-3">contacting server…</div>
        ) : (
          <div className="mt-8 text-meta font-semibold text-accent">could not start pairing</div>
        )}

        {secondsLeft != null && secondsLeft < 120 && code && (
          <p className="mt-6 font-mono text-kicker uppercase tracking-[0.14em] text-ink-3">
            code expires in {secondsLeft}s
          </p>
        )}
        {expired && (
          <p className="mt-6 text-small font-semibold text-accent">
            that code expired — start a new one
          </p>
        )}
        {expired && (
          <button className="btn btn-primary mt-2 justify-center" onClick={() => void requestCode()}>
            <Icon name="refresh" className="h-4 w-4" />
            New code
          </button>
        )}
      </div>
    </div>
  );
}