/**
 * In-memory registry of external acquisition providers. Deliberately not
 * backed by the database — a provider is meant to come and go within a
 * single process lifetime, and a stale row surviving a restart (or a
 * provider that vanished without deregistering) would show a dead entry in
 * the UI forever. Health is re-checked on every list, so a provider that
 * stops answering drops out on its own within one poll cycle.
 */

import { timingSafeEqual } from "node:crypto";

interface Provider {
  label: string;
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>` on every call to this provider — a
   * provider's own API may be reachable from more than just this process (e.g.
   * a container-engine bridge-gateway address that's hard to scope tightly at
   * the network layer), so calls are never made unauthenticated when a token
   * was supplied. Never exposed by listHealthyProviders — write-only. */
  token?: string;
}

const providers = new Map<string, Provider>();

const HEALTH_TIMEOUT_MS = 1_500;
const PROXY_TIMEOUT_MS = 15_000;

function authHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

export function registerProvider(id: string, provider: Provider): void {
  providers.set(id, provider);
}

export function deregisterProvider(id: string): boolean {
  return providers.delete(id);
}

export function hasProvider(id: string): boolean {
  return providers.has(id);
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
 * fallback alongside admin-session auth — if ACQUIRE_REGISTER_KEY isn't
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

async function isHealthy(p: Provider): Promise<boolean> {
  try {
    const res = await fetch(`${p.baseUrl}/health`, { headers: authHeaders(p.token), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Health-checks every registered provider in parallel, drops the dead ones, and returns what survived. */
export async function listHealthyProviders(): Promise<{ id: string; label: string }[]> {
  const entries = [...providers.entries()];
  const checks = await Promise.all(entries.map(async ([id, p]) => [id, await isHealthy(p)] as const));
  const alive: { id: string; label: string }[] = [];
  for (const [id, healthy] of checks) {
    if (healthy) alive.push({ id, label: providers.get(id)!.label });
    else providers.delete(id);
  }
  return alive;
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * Forwards one request to a registered provider. Returns null if the id
 * isn't registered. A network error or timeout is treated the same as a
 * failed health check — the provider is dropped so it stops appearing as a
 * live option — and also returns null.
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
    providers.delete(id);
    return null;
  }
}
