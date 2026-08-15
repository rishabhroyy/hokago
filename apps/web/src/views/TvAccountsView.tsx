import { useReducer, useState } from "react";
import { api } from "../api-client";
import { listAccounts, removeAccount, switchAccount, getActiveAccount } from "../tv-session";
import { Icon } from "../ui/icons";
import { useWiiSound } from "../ui/useWiiSound";
import { TvPairFlow } from "../ui/TvPairFlow";

/**
 * TV "who's watching" — every account paired to this TV, switchable with no
 * password and no re-auth (each account's session lives locally, only the
 * active one is used by the API client). Lives in the web app so the TV shell
 * is a plain webview.
 */
export function TvAccountsView() {
  const s = useWiiSound();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const accounts = listAccounts();
  const active = getActiveAccount()?.id ?? null;
  const [adding, setAdding] = useState(accounts.length === 0);

  const remove = async (id: string) => {
    const account = removeAccount(id);
    if (!account) return;
    // Server-side revocation is a bare token post — no auth required.
    void api
      .POST("/auth/logout", { body: { refreshToken: account.refreshToken } })
      .catch(() => {});
    s.select();
    bump();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-10 px-8">
      {adding ? (
        <TvPairFlow onComplete={() => setAdding(false)} />
      ) : (
        <>
          <h1 className="font-display text-title font-bold">Who's watching?</h1>
          <div className="flex flex-wrap items-stretch justify-center gap-8">
            {accounts.map((a) => (
              <button
                key={a.id}
                data-focusable
                className={`group flex w-[170px] flex-col items-center gap-3 rounded-[26px] p-6 transition-all duration-200 ease-snap hover:-translate-y-1.5 ${
                  a.id === active ? "panel ring-2 ring-wii" : "panel hover:ring-1 hover:ring-line"
                }`}
                onClick={() => {
                  s.select();
                  switchAccount(a.id);
                }}
              >
                <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[linear-gradient(135deg,#45ADDD,#187AA5)] font-display text-[32px] font-black text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.5),0_4px_10px_-2px_rgba(46,155,196,0.55)]">
                  {a.username[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="text-meta font-bold text-ink">{a.username}</span>
                {a.id === active && (
                  <span className="font-mono text-kicker uppercase tracking-[0.14em] text-wii-deep">active</span>
                )}
              </button>
            ))}
            <button
              data-focusable
              className="panel flex w-[170px] flex-col items-center justify-center gap-3 rounded-[26px] p-6 opacity-70 transition-all duration-200 ease-snap hover:-translate-y-1.5 hover:opacity-100"
              onClick={() => {
                s.select();
                setAdding(true);
              }}
            >
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-paper ring-1 ring-line">
                <Icon name="plus" className="h-8 w-8 text-ink-3" />
              </span>
              <span className="text-meta font-bold text-ink-3">Add user</span>
            </button>
          </div>
          {accounts.length > 1 && (
            <div className="flex flex-wrap justify-center gap-2">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  data-focusable
                  className="icobtn flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-accent/10 hover:text-accent"
                  title={`Sign out ${a.username} from this TV`}
                  onClick={() => void remove(a.id)}
                >
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}