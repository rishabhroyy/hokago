import { useEffect, useState } from "react";
import { api } from "./api-client";

export interface PrimaryProfile {
  id: string;
  name: string;
  avatarPath: string | null;
}

// No profile-picker UI exists yet (multi-profile support is unbuilt on
// the frontend) — every view just operates as the account's first profile.
let cached: Promise<PrimaryProfile | null> | null = null;

const listeners = new Set<() => void>();

export function getPrimaryProfile(): Promise<PrimaryProfile | null> {
  if (!cached) {
    cached = api
      .GET("/profiles")
      .then(({ data }) => {
        const p = data?.[0];
        return p ? { id: p.id, name: p.name, avatarPath: p.avatarPath ?? null } : null;
      })
      .catch(() => null);
  }
  return cached;
}

/** Re-fetches the cached profile and re-renders subscribers (TopNav, prefs). */
export function refreshPrimaryProfile() {
  cached = null;
  for (const l of listeners) l();
}

export function usePrimaryProfile(): PrimaryProfile | null {
  const [profile, setProfile] = useState<PrimaryProfile | null>(null);

  useEffect(() => {
    const update = () => {
      void getPrimaryProfile().then(setProfile);
    };
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);

  return profile;
}

export function useProfileId(): string | null {
  return usePrimaryProfile()?.id ?? null;
}

/** The JWT payload carries isAdmin — decoding it locally avoids a /me round-trip. */
export function useIsAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    const token = localStorage.getItem("hokago_access_token");
    if (!token) return;
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      setAdmin(payload.isAdmin === true);
    } catch {
      /* malformed token — stay non-admin */
    }
  }, []);
  return admin;
}