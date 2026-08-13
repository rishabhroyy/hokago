import { useEffect, useState } from "react";
import type { WatchPartyResponse } from "@hokago/contract/watch-party";
import { joinParty } from "../party-api";
import { usePrimaryProfile } from "../profile";
import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import { useWiiSound } from "../ui/useWiiSound";

const normalize = (code: string) =>
  code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/** Join-a-party landing: enter the invite code, land on the player as a
 *  member. The code IS the address — no party list exists anywhere. */
export function PartyView({ code }: { code: string | null }) {
  const { navigate } = useRouter();
  const s = useWiiSound();
  const profile = usePrimaryProfile();
  const [input, setInput] = useState(() => normalize(code ?? ""));
  const [joined, setJoined] = useState<WatchPartyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInput(normalize(code ?? ""));
  }, [code]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const party = await joinParty(input, profile.id);
      if (!party) {
        setError("no party with that code — double-check it with the host");
        return;
      }
      setJoined(party);
      if (party.mediaFileId) {
        s.select();
        navigate(paths.player(party.mediaFileId, party.mediaItemId, profile.id, null, party.id));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <span className="pointer-events-none absolute left-[10%] top-[14%] h-14 w-14 animate-bob text-wii/40">
        <Icon name="users" className="h-full w-full" />
      </span>
      <span className="pointer-events-none absolute bottom-[16%] right-[12%] h-10 w-10 animate-bob text-accent/40 [animation-delay:-1.6s]">
        <Icon name="ticket" className="h-full w-full" />
      </span>

      <div className="panel w-full max-w-[420px] rounded-[32px] p-10">
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark className="mb-5 h-12 w-12" />
          <h1 className="font-display text-title font-bold">watch party</h1>
          <p className="mt-1 text-meta text-ink-2">sync up with friends — same play, same pause</p>
        </div>

        {joined ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="rounded-2xl bg-wii/12 px-4 py-2.5 text-small font-semibold text-wii-deep">
              joined — opening the player
            </p>
            <p className="font-display text-section font-bold">{joined.mediaTitle}</p>
            <p className="text-meta text-ink-3">
              {joined.members.length} in the room ·{" "}
              {joined.state === "PLAYING"
                ? "already playing — you'll sync on arrival"
                : joined.state === "PAUSED"
                  ? "paused — waiting for the host"
                  : "waiting for the host to start"}
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <input
              className="input font-mono text-center text-lg tracking-[0.35em]"
              placeholder="ABCDEF"
              value={input}
              onChange={(e) => setInput(normalize(e.target.value))}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={8}
              required
              autoFocus
            />
            {error && (
              <p className="rounded-2xl bg-accent/10 px-4 py-2.5 text-center text-small font-semibold text-accent">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-primary mt-1 w-full justify-center" disabled={busy || !profile}>
              {busy ? "joining…" : profile ? `Join as ${profile.name}` : "one moment…"}
            </button>
          </form>
        )}

        <button
          type="button"
          className="mt-5 w-full text-center text-small font-bold text-ink-3 transition-colors hover:text-wii-deep"
          onClick={() => navigate(paths.home())}
        >
          back home
        </button>
      </div>
    </div>
  );
}