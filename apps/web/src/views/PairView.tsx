import { useState } from "react";
import { api } from "../api-client";
import { Icon } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import { ThemeToggle } from "../ui/useTheme";
import { useWiiSound } from "../ui/useWiiSound";

/**
 * TV pairing approval: a TV shows a 6-digit code, someone logged in here
 * enters it to bind the TV to their account. The TV then polls the API and
 * gets a session — no password typing on a remote.
 */
export function PairView() {
  const s = useWiiSound();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { data, error: verifyError } = await api.POST("/auth/pair/verify", {
        body: { code: code.trim() },
      });
      if (verifyError || !data?.ok) {
        throw new Error((verifyError as { error?: string } | undefined)?.error ?? "invalid or expired code");
      }
      setDone("approved! your TV is paired to this account. it should wake up on its own.");
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <div className="panel fixed right-6 top-6 z-50 rounded-full p-1.5">
        <ThemeToggle />
      </div>
      <span className="pointer-events-none absolute left-[12%] top-[16%] h-16 w-16 animate-bob text-wii/50">
        <Icon name="cloudsun" className="h-full w-full" />
      </span>

      <form onSubmit={submit} className="panel w-full max-w-[400px] rounded-[32px] p-10">
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark className="mb-5 h-12 w-12" />
          <h1 className="font-display text-title font-bold">pair a TV</h1>
          <p className="mt-1 text-meta text-ink-2">enter the 6-digit code showing on your TV screen</p>
        </div>

        <div className="flex flex-col gap-3">
          <input
            className="input text-center font-mono text-xl tracking-[0.4em]"
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />

          {error && (
            <p className="rounded-2xl bg-accent/10 px-4 py-2.5 text-center text-small font-semibold text-accent">
              {error}
            </p>
          )}
          {done && (
            <p className="rounded-2xl bg-wii/12 px-4 py-2.5 text-center text-small font-semibold text-wii-deep">
              {done}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary mt-1 w-full justify-center"
            disabled={busy || code.trim().length !== 6}
          >
            {busy ? "checking…" : "Approve"}
          </button>
        </div>
      </form>
    </div>
  );
}
