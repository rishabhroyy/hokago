// JASSUB servers the ASS rendering for the player's active text subtitle
// track. It attaches to the underlying <video> whatever the stream method,
// reads the element's clock every presented frame, and draws libass output on
// a canvas layered over the video. This hook owns that instance's lifecycle:
//
// - creation/destruction aligned with the video element + the selected track
//   (never recreated on unrelated renders or offset changes)
// - media-absolute cue timing via timeOffset: the video clock is
//   timeline-relative on resumed/restarted streams, cue times are not
// - seek force-renders: requestVideoFrameCallback only fires on *presented*
//   frames, and a big seek behind the buffered frontier presents nothing for
//   seconds, leaving the previous frame's subs on screen
// - worker/track-load failures surface a callback instead of a quiet dead
//   canvas, with one automatic retry for transient hiccups

import { useEffect, useMemo, useRef, useState } from "react";
import JASSUB from "jassub";
// Vite bundles these from the installed dependency and serves them from our
// own origin — never a CDN — same reasoning as the hls.js fix in WatchPage.
import jassubWorkerUrl from "jassub/dist/worker/worker.js?worker&url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";

import type { FontDescriptor, SubtitleTrackInfo } from "@hokago/contract/media-files";

export function useJassubRenderer({
  videoEl,
  subtitleId,
  subtitles,
  mediaFileId,
  fonts,
  timelineOffsetMs,
  onRenderFailed,
}: {
  /** The provider's <video> — null until a player mount delivered one. */
  videoEl: HTMLVideoElement | null;
  /** The active subtitle track id, or null for subs off. */
  subtitleId: string | null;
  /** Renderable (text-format) subtitle tracks for the current file. */
  subtitles: SubtitleTrackInfo[];
  mediaFileId: string;
  fonts: FontDescriptor[];
  timelineOffsetMs: number;
  /** Fired when a track failed to load/render and the retry also failed. */
  onRenderFailed: () => void;
}): void {
  const jassubRef = useRef<JASSUB | null>(null);
  const failedRef = useRef(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const fontsMap = useMemo(() => Object.fromEntries(fonts.map((f) => [f.family, f.url])), [fonts]);
  const track = useMemo(() => subtitles.find((t) => t.id === subtitleId) ?? null, [subtitles, subtitleId]);

  useEffect(() => {
    if (!videoEl || !track) return;
    // A fresh attempt gets a fresh retry budget (one auto-retry per track).
    failedRef.current = false;
    const instance = new JASSUB({
      video: videoEl,
      subUrl: `/media-files/${mediaFileId}/subtitle-tracks/${track.id}`,
      workerUrl: jassubWorkerUrl,
      wasmUrl: jassubWasmUrl,
      modernWasmUrl: jassubModernWasmUrl,
      availableFonts: fontsMap,
      // ASS cue times are media-absolute; the video clock is timeline-relative
      // (resume/restart rebase). Without the offset every resumed session's
      // subs lag by the whole resume position. Read at creation and kept in
      // lockstep by the offset-sync effect below.
      timeOffset: timelineOffsetMs / 1000,
    });
    jassubRef.current = instance;
    instance.ready.catch(() => {
      // `ready` resolves when the worker finished fetching the track + wasm;
      // a rejection kills rendering while the canvas silently stays on top of
      // the video. Retry once — worker/track fetches are transiently flaky
      // (API restart, first-hit warm-up) — then surface the failure.
      if (jassubRef.current !== instance) return; // superseded by a newer attempt
      if (failedRef.current) {
        onRenderFailed();
        return;
      }
      failedRef.current = true;
      setRetryNonce((n) => n + 1);
    });
    return () => {
      if (jassubRef.current === instance) jassubRef.current = null;
      // destroy() awaits `ready` — a rejected ready rejects destroy too, but
      // the canvas is removed synchronously first (the actual teardown), so
      // the swallow is the whole fix for that path.
      instance.destroy().catch(() => {});
    };
    // timelineOffsetMs / onRenderFailed deliberately excluded: offset changes
    // must not recreate the worker (the sync effect below owns it), and the
    // callback identity would churn the instance on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, track, mediaFileId, fontsMap, retryNonce]);

  // Keep JASSUB's offset in lockstep with restarts (seek / audio switch /
  // quality) — the field is read every rendered frame, so mutating the live
  // instance is enough; no recreation.
  useEffect(() => {
    const jassub = jassubRef.current;
    if (jassub && !jassub._destroyed) jassub.timeOffset = timelineOffsetMs / 1000;
  }, [timelineOffsetMs]);

  // JASSUB renders from requestVideoFrameCallback, which only fires on
  // PRESENTED frames. A big seek (especially past the buffered frontier) leaves
  // currentTime at the target while hls.js buffers — no frames present, so
  // JASSUB keeps rendering the stale pre-seek frame time for many seconds
  // ("subs show a scene from minutes ago"). Force a render at the seek target
  // the moment `seeking` fires so cues track where we actually are.
  useEffect(() => {
    const jassub = jassubRef.current;
    if (!videoEl || !jassub) return;
    const forceSeekRender = () => {
      // The instance can be destroyed/replaced between this effect's setup
      // and the event (track switch, remount) — render nothing on a corpse.
      if (jassubRef.current !== jassub || jassub._destroyed) return;
      const last = jassub._lastDemandTime;
      void jassub.manualRender({
        mediaTime: videoEl.currentTime,
        width: videoEl.videoWidth || last?.width || 0,
        height: videoEl.videoHeight || last?.height || 0,
        expectedDisplayTime: performance.now(),
      });
    };
    videoEl.addEventListener("seeking", forceSeekRender);
    return () => videoEl.removeEventListener("seeking", forceSeekRender);
  }, [videoEl, track?.id]);
}
