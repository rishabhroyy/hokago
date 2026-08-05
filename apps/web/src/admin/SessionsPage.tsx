import { useEffect, useState } from "react";
import { adminApi, fmtDate } from "../admin-api";
import { ActionBtn, Badge, Card, Empty, Table, Td, type Toast } from "./ui";

type Session = Awaited<ReturnType<typeof adminApi.sessions>>[number];

export function SessionsPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    adminApi.sessions().then(setSessions).catch(() => {});
  }, []);

  const revoke = async (id: string) => {
    try { await adminApi.revokeSession(id); toast("session revoked"); } catch { toast("revoke failed", true); }
    adminApi.sessions().then(setSessions).catch(() => {});
  };

  return (
    <Card head="Sessions" hint={`${sessions.length} total`}>
      {sessions.length === 0 ? (
        <Empty>no active sessions.</Empty>
      ) : (
        <Table headers={["account", "device", "user agent", "created", "expires", "state", ""]}>
          {sessions.map((s) => (
            <tr key={s.id}>
              <Td className="font-bold text-ink">{s.username}</Td>
              <Td className="text-ink-2">{s.device ?? "—"}</Td>
              <Td className="max-w-[240px] truncate font-mono text-small text-ink-2" title={s.userAgent ?? ""}>{s.userAgent ?? "—"}</Td>
              <Td className="text-ink-2">{fmtDate(s.createdAt)}</Td>
              <Td className="text-ink-2">{fmtDate(s.expiresAt)}</Td>
              <Td>{s.revokedAt ? <Badge tone="gray">revoked</Badge> : <Badge tone="green">live</Badge>}</Td>
              <Td><span className="flex justify-end">{s.revokedAt ? null : <ActionBtn danger onClick={() => revoke(s.id)}>Revoke</ActionBtn>}</span></Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}