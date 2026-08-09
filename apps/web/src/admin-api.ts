// Admin management API. Thin wrappers over the typed openapi client so the
// admin views don't trip over openapi-fetch's {data?, error} envelope.
import { api } from "./api-client";

async function unwrap<T>(p: Promise<{ data?: T | undefined }>): Promise<T> {
  const { data } = await p;
  if (data === undefined) throw new Error("request failed");
  return data;
}

export const adminApi = {
  summary: () => unwrap(api.GET("/admin-api/summary")),
  attention: () => unwrap(api.GET("/admin-api/attention")),
  libraries: () => unwrap(api.GET("/admin-api/libraries")),
  createLibrary: (body: Record<string, unknown>) => unwrap(api.POST("/admin-api/libraries", { body } as never)),
  updateLibrary: (id: string, body: Record<string, unknown>) => unwrap(api.PATCH("/admin-api/libraries/{id}", { params: { path: { id } }, body } as never)),
  deleteLibrary: (id: string) => unwrap(api.DELETE("/admin-api/libraries/{id}", { params: { path: { id } } })),
  scanLibrary: (id: string) => unwrap(api.POST("/admin-api/libraries/{id}/scan", { params: { path: { id } } })),
  accounts: () => unwrap(api.GET("/admin-api/accounts")),
  createAccount: (body: Record<string, unknown>) => unwrap(api.POST("/admin-api/accounts", { body } as never)),
  patchAccount: (id: string, body: Record<string, unknown>) => unwrap(api.PATCH("/admin-api/accounts/{id}", { params: { path: { id } }, body } as never)),
  deleteAccount: (id: string) => unwrap(api.DELETE("/admin-api/accounts/{id}", { params: { path: { id } } })),
  invites: () => unwrap(api.GET("/admin-api/invites")),
  createInvite: (expiresInDays?: number) =>
    unwrap(api.POST("/admin-api/invites", { body: expiresInDays ? { expiresInDays } : {} })),
  revokeInvite: (id: string) => unwrap(api.DELETE("/admin-api/invites/{id}", { params: { path: { id } } })),
  sessions: () => unwrap(api.GET("/admin-api/sessions")),
  revokeSession: (id: string) => unwrap(api.POST("/admin-api/sessions/{id}/revoke", { params: { path: { id } } })),
  settings: () => unwrap(api.GET("/admin-api/settings")),
  updateSettings: (body: Record<string, unknown>) => unwrap(api.PUT("/admin-api/settings", { body } as never)),
  queues: () => unwrap(api.GET("/admin/queues")),
  queueJobs: (name: string) => unwrap(api.GET("/admin/queues/{name}/jobs", { params: { path: { name }, query: { state: "failed" } } })),
  queueAct: (name: string, act: "pause" | "resume" | "retry-failed" | "clean") => {
    const path = `/admin/queues/${name}/${act}` as never;
    const opts = act === "clean" ? ({ body: { state: "completed" } } as never) : undefined;
    return unwrap(api.POST(path, opts) as never);
  },
};

export const fmtBytes = (b: number | null | undefined): string => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};

export const fmtDate = (s: string | null | undefined): string => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export const fmtNum = (n: number | null | undefined): string => (n ?? 0).toLocaleString();