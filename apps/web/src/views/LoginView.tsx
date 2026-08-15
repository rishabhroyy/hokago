import { useState } from "react";
import { api, storeAuthResult } from "../api-client";
import { clientKey, loginPlatform } from "../native";
import { Icon } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import { ThemeToggle } from "../ui/useTheme";
import { useWiiSound } from "../ui/useWiiSound";

/**
 * auth: username + password, invites are codes shared manually.
 * No email anywhere, no password reset flow — that's an admin action.
 */

// Rotating login flavor text — one per visit, kept to actual anime-isms.
const LOGIN_PHRASES = [
  "moe moe kyun!",
  "welcome back, senpai",
  "it's hokago time",
  "nyaa~ let's watch",
  "chotto matte — that's a new season?",
  "gambare! your episodes await",
  "binge responsibly, senpai",
  "let's fill that queue",
];

export function LoginView() {
  const s = useWiiSound();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [phrase] = useState(() => LOGIN_PHRASES[Math.floor(Math.random() * LOGIN_PHRASES.length)]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("setup") === "done"
      ? "setup complete — sign in with your new admin account"
      : null,
  );
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        const { error: regError } = await api.POST("/auth/register", {
          body: { inviteCode: inviteCode.trim(), username: username.trim(), password },
        });
        if (regError) throw new Error((regError as { error?: string }).error ?? "could not create account");
        setMode("login");
        setNotice("account created — sign in");
        setPassword("");
        return;
      }
      const { data, error: loginError } = await api.POST("/auth/login", {
        body: {
          username: username.trim(),
          password,
          device: "web",
          // Shells identify the device so sessions bind to a real Device row.
          ...(clientKey()
            ? { clientKey: clientKey()!, deviceName: "hokago app", platform: loginPlatform() }
            : {}),
        },
      });
      if (loginError || !data) throw new Error("invalid username or password");
      storeAuthResult({ ...data, username: username.trim() });
      // Full reload: drops the anonymous session's caches and 401 state.
      location.assign("/");
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
      {/* floating channel-art decorations */}
      <span className="pointer-events-none absolute left-[12%] top-[16%] h-16 w-16 animate-bob text-wii/50">
        <Icon name="cloudsun" className="h-full w-full" />
      </span>
      <span className="pointer-events-none absolute bottom-[18%] right-[14%] h-12 w-12 animate-bob text-accent/40 [animation-delay:-2s]">
        <Icon name="sparkle" className="h-full w-full" />
      </span>
      <span className="pointer-events-none absolute right-[22%] top-[20%] h-8 w-8 text-gold/50">
        <Icon name="sparkle" className="h-full w-full" />
      </span>

      <form onSubmit={submit} className="panel w-full max-w-[400px] rounded-[32px] p-10">
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark className="mb-5 h-12 w-12" />
          <h1 className="font-display text-title font-bold">hokago</h1>
          <p className="mt-1 text-meta text-ink-2">
            {mode === "login" ? phrase : "join with an invite code"}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {mode === "register" && (
            <input
              className="input"
              placeholder="Invite code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
              required
            />
          )}
          <input
            className="input"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />

          {error && (
            <p className="rounded-2xl bg-accent/10 px-4 py-2.5 text-center text-small font-semibold text-accent">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-2xl bg-wii/12 px-4 py-2.5 text-center text-small font-semibold text-wii-deep">
              {notice}
            </p>
          )}

          <button type="submit" className="btn btn-primary mt-1 w-full justify-center" disabled={busy}>
            {busy ? "one moment…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </div>

        <button
          type="button"
          className="mt-5 w-full text-center text-small font-bold text-ink-3 transition-colors hover:text-wii-deep"
          onClick={() => {
            s.hover();
            setMode(mode === "login" ? "register" : "login");
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "login" ? "have an invite code? create an account" : "already have an account? sign in"}
        </button>
      </form>
    </div>
  );
}
