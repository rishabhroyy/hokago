/**
 * In-memory registry of external acquisition providers. Deliberately not
 * backed by the database — a provider is meant to come and go within a
 * single process lifetime, and a stale row surviving a restart (or a
 * provider that vanished without deregistering) would show a dead entry in
 * the UI forever. A background sweep (startProviderHealthSweep) evicts a
 * provider that stops answering; listing is a plain synchronous read of
 * whatever survived the last sweep, never a live fetch on the request path.
 */

import { timingSafeEqual } from "node:crypto";

// Reserved — the built-in source lives at /acquire/anicli/*, so nothing may
// register itself under this id and shadow it.
export const RESERVED_PROVIDER_ID = "anicli";

interface Provider {
  label: string;
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>` on every call to this provider — a
   * provider's own API may be reachable from more than just this process (e.g.
   * a container-engine bridge-gateway address that's hard to scope tightly at
   * the network layer), so calls are never made unauthenticated when a token
   * was supplied. Never exposed by listHealthyProviders — write-only.
   * Doubles as an ownership proof: re-registering or deregistering an id that
   * already has one requires presenting this same value (see canClaim) — an
   * id registered without a token stays open to anyone holding the register
   * key, unchanged from before this existed. */
  token?: string;
}

const providers = new Map<string, Provider>();

const HEALTH_TIMEOUT_MS = 1_500;
const PROXY_TIMEOUT_MS = 15_000;

function authHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

/** Constant-time string compare — a naive `===` would leak how many leading bytes matched via timing. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type RegisterKeyCheck = "ok" | "not-enabled" | "unauthorized";

/**
 * Register/deregister auth: a single static key, nothing else. Not a
 * fallback alongside admin-session auth — if HOKAGO_ACQUIRE_KEY isn't
 * configured, this deployment doesn't have external-provider registration
 * at all ("not-enabled"), regardless of who's logged in. If it is
 * configured, only a matching key gets in ("unauthorized" otherwise) — a
 * valid admin session is not itself a way past this.
 */
export function checkRegisterKey(providedHeader: string | string[] | undefined, expectedEnv: string | undefined): RegisterKeyCheck {
  if (!expectedEnv) return "not-enabled";
  if (typeof providedHeader !== "string" || !timingSafeEqualStr(providedHeader, expectedEnv)) return "unauthorized";
  return "ok";
}

/**
 * Per-provider ownership check for register/deregister, layered on top of
 * checkRegisterKey: proves "I control id X" rather than just "I have the
 * shared register key" (which alone would let anyone hijack/delete any id).
 * A brand-new id, or one that was registered without ever setting its own
 * token, stays claimable by the register key alone — this only kicks in
 * once a token has actually been set for that id.
 */
export function canClaim(id: string, providedToken: string | string[] | undefined): boolean {
  const existing = providers.get(id);
  if (!existing || !existing.token) return true;
  return typeof providedToken === "string" && timingSafeEqualStr(providedToken, existing.token);
}

/**
 * False (and a no-op) for the reserved id — checked here, not per call
 * site, so nothing can bypass it. baseUrl's trailing slash (if any) is
 * stripped here too, once, so every downstream `${baseUrl}${path}` join
 * stays a single slash regardless of how the caller formatted it — a
 * trailing slash otherwise produces a double slash that many servers 404
 * on, silently and perpetually evicting an otherwise-reachable provider.
 */
export function registerProvider(id: string, provider: Provider): boolean {
  if (id === RESERVED_PROVIDER_ID) return false;
  providers.set(id, { ...provider, baseUrl: provider.baseUrl.replace(/\/+$/, "") });
  return true;
}

/**
 * Raw connection details for a registered provider — unlike proxyToProvider,
 * this makes no request of its own. Exists for callers that need to hand
 * baseUrl/token to something outside this process (a BullMQ job payload,
 * picked up by the worker) rather than to make a request themselves right
 * now; the registry is this API process's own memory, so anything that
 * needs it later has to carry a copy forward instead of re-querying it.
 */
export function getProviderConnection(id: string): { baseUrl: string; token?: string } | null {
  const p = providers.get(id);
  return p ? { baseUrl: p.baseUrl, token: p.token } : null;
}

export function deregisterProvider(id: string): boolean {
  return providers.delete(id);
}

async function isHealthy(p: Provider): Promise<boolean> {
  try {
    const res = await fetch(`${p.baseUrl}/health`, { headers: authHeaders(p.token), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Health-checks every registered provider in parallel and drops the dead
 * ones — but only if the map entry is still the exact object snapshotted
 * at the start of this sweep, same guard as proxyToProvider's catch below.
 * Without it, a provider that re-registers (a new object) between this
 * sweep snapshotting the old one and its stale health result coming back
 * false would have the fresh, healthy registration deleted out from under
 * it. Exported directly (as well as running on startProviderHealthSweep's
 * interval) so tests can trigger one deterministically instead of waiting
 * out a real interval.
 */
export async function sweepProviderHealth(): Promise<void> {
  const entries = [...providers.entries()];
  const checks = await Promise.all(entries.map(async ([id, p]) => [id, p, await isHealthy(p)] as const));
  for (const [id, p, healthy] of checks) {
    if (!healthy && providers.get(id) === p) providers.delete(id);
  }
}

let sweepTimer: NodeJS.Timeout | undefined;

/** Idempotent — a second call is a no-op, so tests/hot-reload can't stack timers. */
export function startProviderHealthSweep(intervalMs = 10_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweepProviderHealth(), intervalMs);
  sweepTimer.unref();
}

export function stopProviderHealthSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/**
 * Plain synchronous read of the map — no `await` between reading an entry
 * and using it, so there's no window for a concurrent deregister to land
 * mid-function (the crash this used to be able to hit). Eviction of dead
 * providers happens entirely in the background sweep above.
 */
export function listHealthyProviders(): { id: string; label: string }[] {
  return [...providers.entries()].map(([id, p]) => ({ id, label: p.label }));
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * Forwards one request to a registered provider. Returns null if the id
 * isn't registered. A network error or timeout drops the provider so it
 * stops appearing as a live option — but only if the map entry is still the
 * exact object this call started with; if the id was re-registered (a new
 * Provider object) while this call was in flight, the new registration is
 * left alone instead of being deleted out from under it.
 */
export async function proxyToProvider(
  id: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<ProxyResult | null> {
  const p = providers.get(id);
  if (!p) return null;
  try {
    const res = await fetch(`${p.baseUrl}${path}`, {
      method: init.method,
      headers: { ...authHeaders(p.token), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    if (providers.get(id) === p) providers.delete(id);
    return null;
  }
}
