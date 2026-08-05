import { useCallback, useEffect, useState } from "react";
import { adminApi, fmtDate } from "../admin-api";
import { ActionBtn, Badge, Card, Check, Empty, Field, PrimaryBtn, Table, Td, inputCls, type Toast } from "./ui";

type Account = Awaited<ReturnType<typeof adminApi.accounts>>[number];

export function UsersPage({ toast }: { toast: (msg: string, err?: boolean) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  const load = useCallback(() => {
    adminApi.accounts().then(setAccounts).catch(() => setAccounts(null));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    if (!username.trim() || !password) { toast("username and password required", true); return; }
    try {
      await adminApi.createAccount({ username: username.trim(), password, isAdmin });
      toast("user created");
      setShowForm(false);
      setUsername("");
      setPassword("");
      setIsAdmin(false);
      load();
    } catch {
      toast("create failed — maybe the username is taken", true);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>, okMsg: string, errMsg: string) => {
    try { await adminApi.patchAccount(id, body); toast(okMsg); } catch { toast(errMsg, true); }
    load();
  };

  const changePassword = async (id: string) => {
    const p = prompt("New password for this account:");
    if (!p) return;
    await patch(id, { password: p }, "password updated", "update failed");
  };

  const del = async (a: Account) => {
    if (!confirm(`Delete account "${a.username}" and all its profiles/sessions?`)) return;
    try { await adminApi.deleteAccount(a.id); toast("user deleted"); } catch { toast("you can't delete your own account", true); }
    load();
  };

  return (
    <>
      {showForm && (
        <Card head="New user" hint="the account can sign in immediately">
          <div className="grid gap-3.5 sm:grid-cols-3">
            <Field label="username"><input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="guest" /></Field>
            <Field label="password"><input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></Field>
            <Field label="role"><Check checked={isAdmin} onChange={setIsAdmin}>admin</Check></Field>
          </div>
          <div className="mt-4 flex gap-2">
            <PrimaryBtn onClick={create}>Create user</PrimaryBtn>
            <button className={inputCls + " !w-auto px-4"} onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </Card>
      )}

      <Card head="Users" hint={`${accounts?.length ?? 0} total`} right={<ActionBtn icon="plus" onClick={() => setShowForm((v) => !v)}>{showForm ? "Close" : "New user"}</ActionBtn>}>
        {!accounts ? (
          <Empty>loading…</Empty>
        ) : accounts.length === 0 ? (
          <Empty>no accounts yet.</Empty>
        ) : (
          <Table headers={["user", "role", "state", "created", "last login", "sessions", ""]}>
            {accounts.map((a) => (
              <tr key={a.id}>
                <Td>
                  <span className="flex items-center gap-2.5 font-bold text-ink">
                    <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[linear-gradient(135deg,#45ADDD,#187AA5)] text-small font-extrabold uppercase text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
                      {(a.username[0] ?? "?").toUpperCase()}
                    </span>
                    {a.username}
                  </span>
                </Td>
                <Td><Badge tone={a.isAdmin ? "blue" : "gray"}>{a.isAdmin ? "admin" : "member"}</Badge></Td>
                <Td>{a.disabled ? <Badge tone="red">disabled</Badge> : <Badge tone="green">active</Badge>}</Td>
                <Td className="text-ink-2">{fmtDate(a.createdAt)}</Td>
                <Td className="text-ink-2">{fmtDate(a.lastLoginAt)}</Td>
                <Td className="tabular-nums text-ink-2">{a.sessionCount}</Td>
                <Td><span className="flex justify-end gap-1.5">
                  <ActionBtn onClick={() => patch(a.id, { isAdmin: !a.isAdmin }, "user updated", "you can't change your own account like that")}>
                    {a.isAdmin ? "Demote" : "Promote"}
                  </ActionBtn>
                  <ActionBtn onClick={() => patch(a.id, { disabled: !a.disabled }, "user updated", "you can't change your own account like that")}>
                    {a.disabled ? "Enable" : "Disable"}
                  </ActionBtn>
                  <ActionBtn icon="key" onClick={() => changePassword(a.id)}>Password</ActionBtn>
                  <ActionBtn danger icon="trash" onClick={() => del(a)}>Delete</ActionBtn>
                </span></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}