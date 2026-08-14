import { useState } from "react";
import { api, storeAccessToken } from "../api-client";
import { Icon } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import { ThemeToggle } from "../ui/useTheme";
import { useWiiSound } from "../ui/useWiiSound";

const STEPS = ["welcome", "admin account", "libraries", "you're in"] as const;

interface CreatedLibrary {
  name: string;
  rootPath: string;
  contentProfile: "GENERAL" | "ANIME";
}

/** First-run wizard: the whole fresh-install checklist.
 *  1. welcome — what this is
 *  2. admin account — /setup/complete mints the session, so the wizard
 *     continues authenticated through the standard admin API
 *  3. libraries — point hokago at the media folders (each enabled library
 *     enqueues its own scan), skippable for the admin console later
 *  4. done — land inside the app, scans running in the background
 */
export function SetupView() {
  const s = useWiiSound();
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // libraries step state
  const [libs, setLibs] = useState<CreatedLibrary[]>([]);
  const [libName, setLibName] = useState("");
  const [libPath, setLibPath] = useState("");
  const [libProfile, setLibProfile] = useState<"GENERAL" | "ANIME">("GENERAL");
  const [libBusy, setLibBusy] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  const go = (next: number) => {
    s.page(next > step ? 1 : -1);
    setError(null);
    setStep(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (!name) return setError("pick a username first");
    if (password.length < 8) return setError("password needs at least 8 characters");
    if (password !== confirm) return setError("passwords don't match");

    setBusy(true);
    setError(null);
    try {
      const { data, error: apiError } = await api.POST("/setup/complete", {
        body: { username: name, password },
      });
      if (!data) {
        const msg = ((apiError as { error?: string } | undefined)?.error ?? "").toLowerCase();
        if (msg.includes("already complete")) {
          // Someone else finished setup while we were filling the form.
          location.assign("/login");
          return;
        }
        throw new Error((apiError as { error?: string } | undefined)?.error ?? "could not create the admin account");
      }
      // The wizard's own login — the library step talks to the admin API as
      // the freshly minted admin.
      storeAccessToken(data.accessToken);
      localStorage.setItem("hokago_refresh_token", data.refreshToken);
      s.jingle();
      go(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const addLibrary = async () => {
    if (libBusy) return;
    const name = libName.trim();
    const rootPath = libPath.trim();
    if (!name) return setLibError("give the library a name");
    if (!rootPath) return setLibError("point it at a folder — the root path is required");

    setLibBusy(true);
    setLibError(null);
    try {
      const { data, error: apiError } = await api.POST("/admin-api/libraries", {
        body: { name, rootPath, contentProfile: libProfile },
      });
      if (!data) {
        const msg = ((apiError as { error?: string } | undefined)?.error ?? "").toLowerCase();
        if (msg.includes("already used")) {
          throw new Error("that root path is already used by another library");
        }
        throw new Error(msg || "could not add the library");
      }
      s.select();
      setLibs((prev) => [...prev, { name, rootPath, contentProfile: libProfile }]);
      setLibName("");
      setLibPath("");
      setLibProfile("GENERAL");
    } catch (err) {
      setLibError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setLibBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6 py-8">
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

      <div className="panel w-full max-w-[460px] rounded-[32px] p-10">
        {/* step indicator */}
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && <span className={`h-px w-6 ${i <= step ? "bg-wii-deep/60" : "bg-line"}`} />}
              <span
                className={`h-2 w-2 rounded-full transition-colors duration-300 ${
                  i === step ? "bg-wii-deep shadow-[0_0_0_3.5px_rgba(79,184,224,0.28)]" : i < step ? "bg-wii-deep/50" : "bg-line-2"
                }`}
                aria-label={label}
              />
            </div>
          ))}
        </div>

        <div key={step} style={{ animation: "riseIn .45s cubic-bezier(.4,0,.2,1)" }}>
          {step === 0 && (
            <div className="flex flex-col items-center text-center">
              <LogoMark className="mb-5 h-14 w-14" />
<h1 className="font-display text-2xl font-bold text-ink">welcome to hokago</h1>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                  stream movies, TV and anime from your own hardware. watch parties,
                  trickplay scrubbing, zero ads.
                </p>
                <p className="mt-4 text-[13px] leading-relaxed text-ink-3">
                  this takes about a minute: create an{" "}
                  <span className="font-semibold text-ink-2">admin account</span>, then point hokago at your{" "}
                  <span className="font-semibold text-ink-2">media folders</span>. everything else can
                  be changed later in the admin console.
                </p>

              <button
                type="button"
                className="btn btn-primary mt-8 w-full justify-center"
                onMouseEnter={() => s.hover()}
                onClick={() => go(1)}
              >
                get started
              </button>
            </div>
          )}

          {step === 1 && (
            <form onSubmit={submit} className="flex flex-col">
              <div className="mb-7 text-center">
                <LogoMark className="mb-4 h-12 w-12" />
                <h1 className="font-display text-xl font-bold text-ink">create the admin account</h1>
                <p className="mt-1 text-[13px] text-ink-3">this account has full control over hokago</p>
              </div>

              <div className="flex flex-col gap-3">
                <input
                  className="input"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
                <input
                  className="input"
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                <input
                  className="input"
                  type="password"
                  placeholder="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                <p className="text-center text-[12px] text-ink-3">use at least 8 characters</p>

                {error && (
                  <p className="rounded-2xl bg-accent/10 px-4 py-2.5 text-center text-small font-semibold text-accent">{error}</p>
                )}

                <button
                  type="submit"
                  className="btn btn-primary mt-1 w-full justify-center"
                  disabled={busy}
                  onMouseEnter={() => s.hover()}
                >
                  {busy ? "one moment…" : "create admin account"}
                </button>
                <button
                  type="button"
                  className="mt-2 w-full text-center text-small font-bold text-ink-3 transition-colors hover:text-wii-deep"
                  onMouseEnter={() => s.hover()}
                  onClick={() => go(0)}
                >
                  back
                </button>
              </div>
            </form>
          )}

          {step === 2 && (
            <div className="flex flex-col">
              <div className="mb-5 text-center">
                <h1 className="font-display text-xl font-bold text-ink">add your libraries</h1>
                <p className="mt-1 text-[13px] text-ink-3">
                  point hokago at your media folders — each library is scanned automatically
                </p>
              </div>

              {libs.length > 0 && (
                <div className="mb-5 flex flex-col gap-2">
                  {libs.map((l) => (
                    <div
                      key={`${l.name}-${l.rootPath}`}
                      className="flex items-center gap-3 rounded-2xl border border-wii/25 bg-wii/8 px-4 py-2.5"
                    >
                      <Icon name="sparkle" className="h-4 w-4 shrink-0 text-wii-deep" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-bold text-ink">{l.name}</p>
                        <p className="truncate font-mono text-[11.5px] text-ink-3">{l.rootPath}</p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${
                          l.contentProfile === "ANIME" ? "bg-gold/15 text-gold" : "bg-wii/15 text-wii-deep"
                        }`}
                      >
                        {l.contentProfile === "ANIME" ? "anime" : "movies & tv"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-3">
                <input
                  className="input"
                  placeholder="Library name"
                  value={libName}
                  onChange={(e) => setLibName(e.target.value)}
                  autoFocus={libs.length === 0}
                />
                <input
                  className="input font-mono !text-[13px]"
                  placeholder="/media/movies"
                  value={libPath}
                  onChange={(e) => setLibPath(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
                  the path <em>as the server sees it</em> — under docker, that's the folder as mounted
                  inside the container, not the path on your host machine
                </p>

                <div className="flex justify-center gap-2">
                  {(
                    [
                      { value: "GENERAL", label: "movies & tv" },
                      { value: "ANIME", label: "anime" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`rounded-full px-4 py-2 text-[12.5px] font-bold transition-all duration-150 ease-snap ${
                        libProfile === opt.value
                          ? "wii-btn text-white shadow-[0_4px_14px_-4px_rgba(46,155,196,0.7)]"
                          : "bg-paper-2 text-ink-2 hover:bg-wii/15 hover:text-wii-deep"
                      }`}
                      onMouseEnter={() => s.hover()}
                      onClick={() => {
                        s.select();
                        setLibProfile(opt.value);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {libError && (
                  <p className="rounded-2xl bg-accent/10 px-4 py-2.5 text-center text-small font-semibold text-accent">{libError}</p>
                )}

                <button
                  type="button"
                  className="btn btn-primary mt-1 w-full justify-center"
                  disabled={libBusy}
                  onMouseEnter={() => s.hover()}
                  onClick={addLibrary}
                >
                  {libBusy ? "adding…" : libs.length > 0 ? "add another library" : "add library"}
                </button>

                <button
                  type="button"
                  className={`w-full justify-center ${
                    libs.length > 0 ? "btn btn-primary !bg-accent !shadow-[inset_0_1.5px_0_rgba(255,255,255,0.45),0_6px_18px_-6px_rgba(232,102,79,0.6)]" : "btn btn-ghost mt-1"
                  }`}
                  disabled={libBusy}
                  onMouseEnter={() => s.hover()}
                  onClick={() => go(3)}
                >
                  {libs.length > 0 ? "finish setup" : "skip — set up libraries later"}
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center text-center">
              <div className="wii-btn mb-5 flex h-14 w-14 items-center justify-center rounded-full shadow-[0_8px_24px_-8px_rgba(46,155,196,0.8)]">
                <Icon name="sparkle" className="h-7 w-7 text-white" />
              </div>
<h1 className="font-display text-2xl font-bold text-ink">all set</h1>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                  {libs.length > 0 ? (
                    <>
                      {libs.length} {libs.length === 1 ? "library is" : "libraries are"} set up and
                      scanning in the background — your shows will start appearing as the worker
                      processes them.
                    </>
                  ) : (
                    <>
                      you can add libraries anytime from the admin console
                      (<span className="font-semibold text-ink">/admin</span>).
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className="btn btn-primary mt-8 w-full justify-center"
                  onMouseEnter={() => s.hover()}
                  onClick={() => {
                    s.select();
                    location.assign("/");
                  }}
                >
                  open hokago
                </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}