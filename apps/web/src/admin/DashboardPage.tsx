import { useEffect, useState } from "react";
import { adminApi, fmtBytes, fmtDate, fmtNum } from "../admin-api";
import { paths, useRouter } from "../router";
import { Badge, Card, Empty, Stat, Table, Td } from "./ui";

type Summary = Awaited<ReturnType<typeof adminApi.summary>>;
type Attention = Awaited<ReturnType<typeof adminApi.attention>>;

export function DashboardPage() {
  const { navigate } = useRouter();
  const [s, setS] = useState<Summary | null>(null);
  const [attention, setAttention] = useState<Attention>([]);

  useEffect(() => {
    let cancelled = false;
    adminApi.summary().then((d) => !cancelled && setS(d)).catch(() => !cancelled && setS(null));
    adminApi.attention().then((d) => !cancelled && setAttention(d)).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!s) return <Card head="Dashboard" hint="loading…" children={null} />;

  const kindLine = Object.entries(s.itemKinds).map(([k, v]) => `${fmtNum(v)} ${k.toLowerCase()}`).join(" · ");

  return (
    <>
      <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3.5">
        <Stat icon="film" value={fmtNum(s.items)} label="media items" sub={kindLine} />
        <Stat icon="disk" tone="green" value={fmtBytes(s.mediaBytes)} label="media storage" sub={`${fmtNum(s.mediaFiles)} files · ${fmtBytes(s.artworkBytes)} artwork`} />
        <Stat icon="lib" tone="gold" value={fmtNum(s.libraries)} label="libraries" sub={`${fmtDate(s.lastScanAt)} last scan`} />
        <Stat icon="users" value={fmtNum(s.accounts)} label="accounts" sub={`${fmtNum(s.profiles)} profiles`} />
        <Stat icon="tv" tone="green" value={fmtNum(s.activeSessions)} label="watching now" sub={`${fmtNum(s.runningTranscodes)} transcoding`} />
        <Stat icon="alert" tone={s.needsAttention > 0 ? "red" : "gold"} value={fmtNum(s.needsAttention)} label="needs attention" sub={s.needsAttention > 0 ? "poison-pill or failed jobs" : "all clear"} />
      </div>

      <Card head="Queues" hint="pause/resume and retries on the Jobs page">
        <Table headers={["queue", "state", "waiting", "active", "delayed", "failed", "completed"]}>
          {s.queues.map((q) => (
            <tr key={q.name}>
              <Td className="font-mono text-small font-semibold">{q.name}</Td>
              <Td><Badge tone={q.paused ? "gold" : "green"}>{q.paused ? "paused" : "running"}</Badge></Td>
              <Td className="tabular-nums text-ink-3">{q.counts.waiting ?? 0}</Td>
              <Td className="tabular-nums">{q.counts.active ?? 0}</Td>
              <Td className="tabular-nums text-ink-3">{q.counts.delayed ?? 0}</Td>
              <Td className={`tabular-nums ${(q.counts.failed ?? 0) > 0 ? "" : "text-ink-3"}`}>{q.counts.failed ?? 0}</Td>
              <Td className="tabular-nums text-ink-3">{q.counts.completed ?? 0}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card head="Needs attention" hint={`${attention.length} items`}>
        {attention.length === 0 ? (
          <Empty>nothing needs attention — everything resolved cleanly.</Empty>
        ) : (
          <Table headers={["title", "kind", "library", "confidence", "failures"]}>
            {attention.map((it) => (
              <tr key={it.id}>
                <Td>
                  <button className="font-bold text-wii-deep hover:underline" onClick={() => navigate(paths.detail(it.id))}>
                    {it.title}
                  </button>
                </Td>
                <Td className="font-mono text-small text-ink-2">{it.kind}</Td>
                <Td className="text-ink-2">{it.libraryName}</Td>
                <Td className="tabular-nums">{Math.round(it.confidence * 100)}%</Td>
                <Td className="flex flex-wrap gap-1.5">
                  {it.failures.map((f) => (
                    <span key={f.jobType + f.lastFailedAt} title={f.lastError ?? undefined}>
                      <Badge tone="red">{f.jobType} ×{f.attempts}</Badge>
                    </span>
                  ))}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}