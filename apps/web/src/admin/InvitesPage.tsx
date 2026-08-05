import { useEffect, useState } from "react";
import { adminApi, fmtDate } from "../admin-api";
import { ActionBtn, Badge, Card, Empty, Field, PrimaryBtn, Table, Td, inputCls, type Toast } from "./ui";

type Invite = Awaited<ReturnType<typeof adminApi.invites>>[number];

export function InvitesPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [days, setDays] = useState("");

  useEffect(() => {
    adminApi.invites().then(setInvites).catch(() => {});
  }, []);

  const create = async () => {
    try {
      const invite = await adminApi.createInvite(days ? Number(days) : undefined);
      navigator.clipboard?.writeText(invite.code).catch(() => {});
      toast(`invite ${invite.code} — copied to clipboard`);
      setDays("");
    } catch { toast("create failed", true); }
    adminApi.invites().then(setInvites).catch(() => {});
  };

  const copy = (code: string) => {
    navigator.clipboard?.writeText(code).catch(() => {});
    toast("code copied");
  };

  const revoke = async (id: string) => {
    try { await adminApi.revokeInvite(id); toast("invite revoked"); } catch { toast("revoke failed", true); }
    adminApi.invites().then(setInvites).catch(() => {});
  };

  return (
    <>
      <Card head="New invite" hint="codes are shared manually — no email, ever">
        <div className="flex items-end gap-3.5">
          <Field label="expires in (days, empty = never)">
            <input className={inputCls} type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder="30" />
          </Field>
          <PrimaryBtn icon="plus" onClick={create}>Create invite</PrimaryBtn>
        </div>
      </Card>

      <Card head="Invites" hint={`${invites.length} total`}>
        {invites.length === 0 ? (
          <Empty>no invite codes yet — create one to let new accounts register.</Empty>
        ) : (
          <Table headers={["code", "created by", "created", "expires", "state", ""]}>
            {invites.map((i) => (
              <tr key={i.id}>
                <Td>
                  <span className="inline-flex items-center gap-2 rounded-[10px] bg-paper-2/60 px-3 py-1.5 font-mono text-small font-bold tracking-wide text-ink dark:bg-paper-2/25">
                    {i.code}
                    <button className="text-ink-3 transition hover:text-wii-deep" onClick={() => copy(i.code)} title="copy">
                      <span className="sr-only">copy</span>⧉
                    </button>
                  </span>
                </Td>
                <Td className="text-ink-2">{i.createdBy}</Td>
                <Td className="text-ink-2">{fmtDate(i.createdAt)}</Td>
                <Td className="text-ink-2">{fmtDate(i.expiresAt)}</Td>
                <Td>{i.usedAt ? <Badge tone="gray">used · {fmtDate(i.usedAt)}</Badge> : <Badge tone="green">open</Badge>}</Td>
                <Td><span className="flex justify-end">{i.usedAt ? null : <ActionBtn danger onClick={() => revoke(i.id)}>Revoke</ActionBtn>}</span></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}