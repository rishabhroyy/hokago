import { useRef, useState } from "react";
import { api } from "../api-client";
import { refreshPrimaryProfile, usePrimaryProfile } from "../profile";
import { Icon } from "../ui/icons";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

interface ApiError {
  error?: string;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ApiError | null;
  if (res.status === 401 || res.status === 403) return "session expired — sign in again";
  return body?.error ?? fallback;
}

function uploadAvatar(file: File): Promise<string> {
  return fetch("/avatars", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("hokago_access_token") ?? ""}`,
      "Content-Type": "application/octet-stream",
    },
    body: file,
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorMessage(res, "upload failed"));
    const body = (await res.json().catch(() => null)) as { avatarPath?: string } | null;
    if (!body?.avatarPath) throw new Error("upload failed — no avatar path returned");
    return body.avatarPath;
  });
}

function Note({ children }: { children: string }) {
  return <span className="ml-auto rounded-full bg-wii/12 px-3 py-1 text-small font-semibold text-wii-deep">{children}</span>;
}

function ErrorText({ children }: { children: string }) {
  return <p className="text-small font-semibold text-accent">{children}</p>;
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
      if (error) throw new Error((error as ApiError).error ?? "could not rename profile");
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
      if (error) throw new Error((error as ApiError).error ?? "could not change password");
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
    <div className="mx-auto w-full max-w-[640px] px-12 pb-12 pt-[86px] max-[820px]:px-5">
      <div className="pb-[26px] pt-[30px]">
        <div className="mb-[18px] flex items-baseline gap-3.5">
          <h1 className="font-display text-title font-bold tracking-[-0.01em]">preferences</h1>
          <span className="font-mono text-kicker font-bold uppercase tracking-[0.14em] text-ink-3">account settings</span>
        </div>
        <p className="mt-1 text-body text-ink-2">look after your own account — picture, name, password.</p>
      </div>

      <section className="panel mb-6 rounded-[32px] p-10">
        <div className="mb-[18px] flex flex-wrap items-center gap-3">
          <h2 className="font-display text-section font-bold tracking-[0.01em] text-ink">Profile picture</h2>
          {avatarNote && <Note>{avatarNote}</Note>}
        </div>
        <div className="flex items-center gap-5">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#45ADDD,#187AA5)] font-display text-title font-bold text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.5),0_3px_8px_-2px_rgba(46,155,196,0.55)] ring-2 ring-white/70">
            {preview ? (
              <img src={preview} alt="" className="h-full w-full object-cover" />
            ) : profile?.avatarPath ? (
              <img src={profile.avatarPath} alt="" className="h-full w-full object-cover" />
            ) : (
              (profile?.name?.[0] ?? "h").toLowerCase()
            )}
          </span>
          <div className="min-w-0">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={onPick}
              disabled={avatarBusy}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={avatarBusy}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="edit" className="h-4 w-4" />
              {avatarBusy ? "uploading…" : "Choose image"}
            </button>
            <p className="mt-2 text-small text-ink-3">jpeg, png, webp, or gif — stored on this server, no third-party links.</p>
            {avatarErr && <ErrorText>{avatarErr}</ErrorText>}
          </div>
        </div>
      </section>

      <section className="panel mb-6 rounded-[32px] p-10">
        <div className="mb-[18px] flex flex-wrap items-center gap-3">
          <h2 className="font-display text-section font-bold tracking-[0.01em] text-ink">Display name</h2>
          {nameNote && <Note>{nameNote}</Note>}
        </div>
        <form onSubmit={saveName} className="flex flex-col gap-3">
          <input
            className="input"
            placeholder={profile?.name ?? "profile name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
          />
          {nameErr && <ErrorText>{nameErr}</ErrorText>}
          <div>
            <button type="submit" className="btn btn-primary" disabled={nameBusy || !name.trim()}>
              {nameBusy ? "saving…" : "Save name"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel rounded-[32px] p-10">
        <div className="mb-[18px] flex flex-wrap items-center gap-3">
          <h2 className="font-display text-section font-bold tracking-[0.01em] text-ink">Password</h2>
          {pwNote && <Note>{pwNote}</Note>}
        </div>
        <form onSubmit={savePassword} className="flex flex-col gap-3">
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
          {pwErr && <ErrorText>{pwErr}</ErrorText>}
          <div>
            <button type="submit" className="btn btn-primary" disabled={pwBusy}>
              {pwBusy ? "changing…" : "Change password"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
