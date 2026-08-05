import { useCallback, useEffect, useState } from "react";
import { adminApi } from "../admin-api";
import { ActionBtn, Badge, Card, Empty, type Toast } from "./ui";

type Queue = Awaited<ReturnType<typeof adminApi.queues>>[number];

const HOT = new Set(["failed", "dead"]);
const ACTIVE = new Set(["active", "waiting", "delayed"]);

export function JobsPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [dumps, setDumps] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    adminApi.queues().then(setQueues).catch(() => setQueues([]));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (q: string, action: "pause" | "resume" | "retry-failed" | "clean") => {
    try {
      await adminApi.queueAct(q, action);
      toast(action === "retry-failed" ? "failed jobs requeued" : action === "clean" ? "completed jobs cleaned" : action === "pause" ? "queue paused" : "queue resumed");
    } catch { toast("action failed", true); }
    load();
  };

  const toggleDump = async (q: string) => {
    setDumps((prev) => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  };

  if (queues.length === 0) {
    return <Card head="Jobs" hint="live · 5s"><Empty>no queues yet — they'll appear once the worker boots.</Empty></Card>;
  }

  return (
    <>
      {queues.map((q) => (
        <Card key={q.name} head={<span className="font-mono">{q.name}</span>} hint="live · 5s" right={<Badge tone={q.paused ? "gold" : "green"}>{q.paused ? "paused" : "running"}</Badge>}>
          <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(88px,1fr))] gap-2">
            {Object.entries(q.counts).map(([k, v]) => (
              <div
                key={k}
                className={`rounded-xl border px-3 py-2 text-center ${
                  HOT.has(k) && v > 0
                    ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
                    : ACTIVE.has(k) && v > 0
                      ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
                      : "border-line bg-paper-2/40 text-ink-2 dark:bg-paper-2/20"
                }`}
              >
                <div className="text-section font-extrabold leading-tight tabular-nums">{v}</div>
                <div className="font-mono text-kicker font-bold uppercase tracking-[0.08em] opacity-70">{k}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionBtn onClick={() => act(q.name, q.paused ? "resume" : "pause")}>{q.paused ? "Resume" : "Pause"}</ActionBtn>
            <ActionBtn onClick={() => act(q.name, "retry-failed")}>Retry failed</ActionBtn>
            <ActionBtn icon="broom" onClick={() => act(q.name, "clean")}>Clean completed</ActionBtn>
            <ActionBtn icon="list" onClick={() => toggleDump(q.name)}>Show failed jobs</ActionBtn>
          </div>
          {dumps.has(q.name) && <FailedDump name={q.name} />}
        </Card>
      ))}
    </>
  );
}

function FailedDump({ name }: { name: string }) {
  const [text, setText] = useState<string>("loading…");
  useEffect(() => {
    let cancelled = false;
    adminApi.queueJobs(name).then((jobs) => !cancelled && setText(JSON.stringify(jobs, null, 2))).catch(() => !cancelled && setText("failed to load jobs"));
    return () => { cancelled = true; };
  }, [name]);
  return (
    <pre className="mt-4 max-h-[320px] overflow-auto rounded-xl border border-line bg-paper-2/40 p-3 font-mono text-small leading-relaxed text-ink-2 dark:bg-black/30">
      {text}
    </pre>
  );
}