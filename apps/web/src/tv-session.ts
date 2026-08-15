/**
 * TV-mode sessions: a TV shell is one device hosting many accounts. Every
 * account that completes the pair flow is stored here; the active one is
 * switched locally (no re-auth) and the api-client's token storage routes
 * through this module while a TV shell is present.
 *
 * Never used on phone/desktop/web — there the legacy single-session
 * localStorage keys in api-client.ts keep working untouched.
 */

import { isTvShell } from "@hokago/native-bridge";

export interface TvAccount {
  id: string; // pairing id — stable across the account's session
  username: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  deviceId: string | null;
  pairedAt: string; // ISO
}

const ACCOUNTS_KEY = "hokago_tv_accounts";
const ACTIVE_KEY = "hokago_tv_active";

function rawAccounts(): TvAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as TvAccount[]) : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts: TvAccount[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function getActiveAccount(): TvAccount | null {
  if (!isTvShell()) return null;
  const id = localStorage.getItem(ACTIVE_KEY);
  return rawAccounts().find((a) => a.id === id) ?? null;
}

export function listAccounts(): TvAccount[] {
  return isTvShell() ? rawAccounts() : [];
}

export function hasActiveAccount(): boolean {
  return getActiveAccount() !== null;
}

/** Add (or refresh) an account after a completed pairing — becomes active. */
export function addAccount(account: Omit<TvAccount, "id" | "pairedAt">): TvAccount {
  const accounts = rawAccounts();
  const existing = accounts.find((a) => a.username === account.username);
  const entry: TvAccount = {
    ...account,
    id: existing?.id ?? crypto.randomUUID(),
    pairedAt: existing?.pairedAt ?? new Date().toISOString(),
  };
  const next = existing ? accounts.map((a) => (a.id === existing.id ? entry : a)) : [...accounts, entry];
  saveAccounts(next);
  localStorage.setItem(ACTIVE_KEY, entry.id);
  return entry;
}

/** Rotate the active account's session after a successful token refresh. */
export function updateActiveTokens(accessToken: string, refreshToken?: string): void {
  const active = getActiveAccount();
  if (!active) return;
  saveAccounts(
    rawAccounts().map((a) =>
      a.id === active.id ? { ...a, accessToken, ...(refreshToken ? { refreshToken } : {}) } : a,
    ),
  );
}

export function switchAccount(id: string): void {
  if (!rawAccounts().some((a) => a.id === id)) return;
  localStorage.setItem(ACTIVE_KEY, id);
  location.assign("/");
}

/** Drop one account. Returns it (for server-side logout) — the next account
 *  becomes active, or none if it was the last. */
export function removeAccount(id: string): TvAccount | null {
  const accounts = rawAccounts();
  const removed = accounts.find((a) => a.id === id) ?? null;
  const next = accounts.filter((a) => a.id !== id);
  saveAccounts(next);
  if (localStorage.getItem(ACTIVE_KEY) === id) {
    localStorage.removeItem(ACTIVE_KEY);
    if (next.length > 0) localStorage.setItem(ACTIVE_KEY, next[0].id);
  }
  return removed;
}