import { useCallback, useEffect, useRef, useState } from "react";
import { getNativeBridge, isNetworkLikelyOffline } from "@hokago/native-bridge";
import { flushWatchSync } from "./offline";

/**
 * Online/offline tracking for the whole app. Two signals:
 *   - navigator.onLine (the link is down)
 *   - /health probe failures (link up but the server unreachable — the shell
 *     is serving a bundled SPA, so the page itself loaded fine).
 * While offline, playback writes go to the offline watch-queue; the moment a
 * probe succeeds again, the queue is flushed to /watch-state/sync.
 */
export function useConnectivity(profileId: string | null) {
  const [online, setOnline] = useState(!isNetworkLikelyOffline());
  const [justReconnected, setJustReconnected] = useState(false);
  const onlineRef = useRef(online);
  const profileRef = useRef(profileId);
  profileRef.current = profileId;

  const markOnline = useCallback(() => {
    if (!onlineRef.current) {
      setJustReconnected(true);
      setTimeout(() => setJustReconnected(false), 4000);
    }
    onlineRef.current = true;
    setOnline(true);
    if (profileRef.current) {
      flushWatchSync(profileRef.current).catch(() => {});
    }
  }, []);

  const markOffline = useCallback(() => {
    onlineRef.current = false;
    setOnline(false);
  }, []);

  // Link-level changes.
  useEffect(() => {
    const goOnline = () => markOnline();
    const goOffline = () => markOffline();
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [markOnline, markOffline]);

  // Server probe: /health is unauthenticated (native clients use it too).
  // Poll while offline; the first success is the reconnect moment. Uses the
  // shell's configured server origin so it reaches the real server even when
  // this SPA copy is served from a local custom scheme.
  useEffect(() => {
    if (onlineRef.current) return;
    let cancelled = false;
    const base = getNativeBridge()?.serverUrl?.replace(/\/$/, "") ?? "";
    const probe = async () => {
      try {
        const res = await fetch(`${base}/health`, { method: "GET", cache: "no-store" });
        if (!cancelled && res.ok) markOnline();
      } catch {
        // still offline
      }
    };
    const id = setInterval(() => void probe(), 5000);
    void probe();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [online, markOnline]);

  return { online, justReconnected };
}
