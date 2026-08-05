import { useRef, useState } from "react";
import { api } from "../api-client";
import { refreshPrimaryProfile, usePrimaryProfile } from "../profile";
import { Icon } from "../ui/icons";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Raw binary upload — jpeg/png/webp/gif, served from our own origin. */
async function uploadAvatar(file: File): Promise<string> {
  const res = await fetch("/avatars", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("hokago_access_token") ?? ""}`,
      "Content-Type": "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "upload failed");
  }
  return ((await res.json()) as { avatarPath: string }).avatarPath;
}

function ZoneStatus({ err, note }: { err: string | null; note: string | null }) {
  const ok = !err;
  const msg = err ?? note;
  if (!msg) return null;
  return (
    <p className={`mt-3 flex items-center gap-1.5 text-small font-semibold ${ok ? "text-wii-deep" : "text-accent"}`}>
      <Icon name={ok ? "check" : "alert"} className="h-3.5 w-3.5 shrink-0" />
      {msg}
    </p>
  );
}

export function PrefsView() {
  const profile = usePrimaryProfile();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarErr, setAvatarErr] = useState<string | null>(null);
  const [avatarNote, setAvatarNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [nameBusy, setNameBusy] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [nameNote, setNameNote] = useState<string | null>(null);

  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwNote, setPwNote] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !profile) return;
    setAvatarErr(null);
    setAvatarNote(null);
    if (!AVATAR_TYPES.has(file.type)) {
      setAvatarErr("that file type is not supported — use jpeg, png, webp, or gif");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarErr("image is too big — keep it under 8 MB");
      return;
    }
    setPreview(URL.createObjectURL(file));
    setAvatarBusy(true);
    try {
      await uploadAvatar(file);
      refreshPrimaryProfile();
      setAvatarNote("profile picture updated");
    } catch (err) {
      setAvatarErr(err instanceof Error ? err.message : "upload failed");
      setPreview(null);
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || nameBusy) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setNameBusy(true);
    setNameErr(null);
    setNameNote(null);
    try {
      const { error } = await api.PATCH("/profiles/{id}", {
        params: { path: { id: profile.id } },
        body: { name: trimmed },
      });
      if (error) throw new Error((error as { error?: string }).error ?? "could not rename profile");
      refreshPrimaryProfile();
      setName("");
      setNameNote("display name updated");
    } catch (err) {
      setNameErr(err instanceof Error ? err.message : "could not save");
    } finally {
      setNameBusy(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwBusy) return;
    setPwErr(null);
    setPwNote(null);
    if (!cur || !pw) {
      setPwErr("fill in both password fields");
      return;
    }
    if (pw !== confirm) {
      setPwErr("new passwords do not match");
      return;
    }
    if (pw === cur) {
      setPwErr("new password must differ from the current one");
      return;
    }
    setPwBusy(true);
    try {
      const { error } = await api.POST("/auth/password", {
        body: { currentPassword: cur, newPassword: pw },
      });
      if (error) throw new Error((error as { error?: string }).error ?? "could not change password");
      setCur("");
      setPw("");
      setConfirm("");
      setPwNote("password changed");
    } catch (err) {
      setPwErr(err instanceof Error ? err.message : "could not change password");
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div className="min-h-screen px-12 pb-20 pt-[86px] max-[820px]:px-5">
      <div className="pb-[26px]">
        <div className="mb-[18px] flex items-baseline gap-3.5">
          <h2 className="font-display text-title font-bold tracking-[-0.01em]">preferences</h2>
          <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">
            account settings
          </span>
        </div>
        <p className="max-w-[52ch] text-body text-ink-2">
          look after your own account — the picture people see, the name beside it, and the password that
          keeps it yours.
        </p>
      </div>

      <div className="panel mx-auto w-full max-w-[720px] rounded-panel px-7 shadow-panel max-[820px]:px-5">
        <section className="border-b border-line/60 py-7 first:pt-7">
          <div className="flex items-start gap-5">
            <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#45ADDD,#187AA5)] font-display text-title font-bold text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.5),0_3px_8px_-2px_rgba(46,155,196,0.55)] ring-2 ring-white/70">
              {preview ? (
                <img src={preview} alt="" className="h-full w-full object-cover" />
              ) : profile?.avatarPath ? (
                <img src={profile.avatarPath} alt="" className="h-full w-full object-cover" />
              ) : (
                (profile?.name?.[0] ?? "h").toLowerCase()
              )}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-section font-bold">Profile picture</h3>
              <p className="mt-1 text-small text-ink-3">
                jpeg, png, webp, or gif — served from this server, never a third-party link.
              </p>
              <div className="mt-4">
                <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={onPick} disabled={avatarBusy} />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={avatarBusy}
                  onClick={() => fileRef.current?.click()}
                >
                  <Icon name="edit" className="h-4 w-4" />
                  {avatarBusy ? "uploading…" : profile?.avatarPath ? "Change picture" : "Choose image"}
                </button>
              </div>
              <ZoneStatus err={avatarErr} note={avatarNote} />
            </div>
          </div>
        </section>

        <section className="border-b border-line/60 py-7">
          <h3 className="font-display text-section font-bold">Display name</h3>
          <p className="mt-1 text-small text-ink-3">shows in the corner of the screen.</p>
          <form onSubmit={saveName} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              className="input flex-1"
              placeholder={profile?.name ?? "profile name"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
            <button type="submit" className="btn btn-primary shrink-0" disabled={nameBusy || !name.trim()}>
              {nameBusy ? "saving…" : "Save name"}
            </button>
          </form>
          <ZoneStatus err={nameErr} note={nameNote} />
        </section>

        <section className="py-7">
          <h3 className="font-display text-section font-bold">Password</h3>
          <p className="mt-1 text-small text-ink-3">
            forgot it? there is no reset flow — that is an admin action.
          </p>
          <form onSubmit={savePassword} className="mt-4 flex max-w-[420px] flex-col gap-3">
            <input
              className="input"
              type="password"
              placeholder="Current password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
              autoComplete="current-password"
            />
            <input
              className="input"
              type="password"
              placeholder="New password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
            />
            <input
              className="input"
              type="password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            <div className="pt-1">
              <button type="submit" className="btn btn-primary" disabled={pwBusy}>
                {pwBusy ? "changing…" : "Change password"}
              </button>
            </div>
          </form>
          <ZoneStatus err={pwErr} note={pwNote} />
        </section>
      </div>
    </div>
  );
}
