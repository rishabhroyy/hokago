import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";

import {
  registerProvider,
  deregisterProvider,
  listHealthyProviders,
  proxyToProvider,
  checkRegisterKey,
  canClaim,
  sweepProviderHealth,
  RESERVED_PROVIDER_ID,
} from "./acquire-provider-registry.js";

async function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("unexpected server address");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

test("register -> list -> background sweep drops a dead provider -> proxy 404s", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });

  registerProvider("drop-test", { label: "Drop Test", baseUrl });
  const alive = listHealthyProviders();
  assert.ok(alive.some((p) => p.id === "drop-test"), "healthy provider should be listed");

  // Server goes away -- eviction now happens only via the background sweep,
  // never on the listHealthyProviders() request path itself.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sweepProviderHealth();
  const afterDeath = listHealthyProviders();
  assert.ok(!afterDeath.some((p) => p.id === "drop-test"), "dead provider should be dropped after a sweep");

  const proxied = await proxyToProvider("drop-test", "/search", { method: "POST", body: { query: "x" } });
  assert.equal(proxied, null, "a dropped provider must 404 (proxyToProvider returns null)");

  deregisterProvider("drop-test");
});

test("listHealthyProviders is a synchronous map read, unaffected by a deregister around it", () => {
  // The bug this guards: the old implementation awaited a health check
  // per entry, then did `providers.get(id)!.label` afterwards -- if that id
  // was deregistered during the await, `.get(id)` was undefined and `!`
  // threw. Eviction now lives entirely in sweepProviderHealth (above), and
  // listHealthyProviders itself has no `await` between reading the map and
  // using it -- nothing can interleave with it, so there is no window left
  // for a concurrent deregister to land in.
  registerProvider("sync-test", { label: "Sync Test", baseUrl: "http://127.0.0.1:1" });
  assert.ok(listHealthyProviders().some((p) => p.id === "sync-test"));
  deregisterProvider("sync-test");
  assert.ok(!listHealthyProviders().some((p) => p.id === "sync-test"));
});

test("proxy forwards verbatim to a registered provider, with its token as a bearer header, and 404s for an unregistered id", async () => {
  let seenAuth: string | undefined;
  const { baseUrl, server } = await startServer((req, res) => {
    seenAuth = req.headers.authorization;
    if (req.url === "/health") {
      res.writeHead(200).end();
      return;
    }
    if (req.url === "/search" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ candidates: [{ title: "Frieren", year: 2023, posterUrl: null }] }));
      return;
    }
    res.writeHead(404).end();
  });

  registerProvider("forward-test", { label: "Forward Test", baseUrl, token: "s3cret" });

  const result = await proxyToProvider("forward-test", "/search", { method: "POST", body: { query: "frieren" } });
  assert.ok(result, "expected a proxied result");
  assert.equal(result!.status, 201);
  assert.deepEqual(result!.body, { candidates: [{ title: "Frieren", year: 2023, posterUrl: null }] });
  assert.equal(seenAuth, "Bearer s3cret", "token must be forwarded as a bearer header");

  const missing = await proxyToProvider("no-such-provider", "/search", { method: "POST", body: { query: "x" } });
  assert.equal(missing, null, "an unregistered id must return null");

  deregisterProvider("forward-test");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("proxyToProvider only evicts the exact registration it started with, not a re-registration that replaced it mid-flight", async () => {
  const dead = createServer((req) => {
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadAddr = dead.address();
  if (deadAddr === null || typeof deadAddr === "string") throw new Error("unexpected server address");
  const deadUrl = `http://127.0.0.1:${deadAddr.port}`;

  const { baseUrl: aliveUrl, server: alive } = await startServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end();
      return;
    }
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ candidates: [] }));
  });

  registerProvider("swap-test", { label: "A (dying)", baseUrl: deadUrl });

  const inFlight = proxyToProvider("swap-test", "/search", { method: "POST", body: { query: "x" } });
  // Re-register the same id to a healthy provider while the call above is
  // still in flight against the dying one -- this is the race: the old
  // implementation's catch did an unconditional providers.delete(id), which
  // would have deleted the NEW registration once the old call's promise
  // rejected, even though the new one never failed.
  registerProvider("swap-test", { label: "B (alive)", baseUrl: aliveUrl });

  const result = await inFlight;
  assert.equal(result, null, "the original in-flight call against the dead server must still fail");

  assert.ok(listHealthyProviders().some((p) => p.id === "swap-test"), "the new registration must survive the old call's failure");
  const afterSwap = await proxyToProvider("swap-test", "/search", { method: "POST", body: { query: "x" } });
  assert.ok(afterSwap, "the surviving registration must still be usable");
  assert.equal(afterSwap!.status, 201);

  deregisterProvider("swap-test");
  await new Promise<void>((resolve) => dead.close(() => resolve()));
  await new Promise<void>((resolve) => alive.close(() => resolve()));
});

test("sweepProviderHealth only evicts the exact registration it snapshotted, not a re-registration that replaced it mid-sweep", async () => {
  const { baseUrl: unhealthyUrl, server: unhealthy } = await startServer((req, res) => {
    res.writeHead(404).end();
  });
  const { baseUrl: healthyUrl, server: healthy } = await startServer((req, res) => {
    res.writeHead(200).end();
  });

  registerProvider("sweep-swap", { label: "A (unhealthy)", baseUrl: unhealthyUrl });

  const sweeping = sweepProviderHealth();
  // Re-register the same id to a healthy provider while the sweep above is
  // still checking the old one -- the bug: the old implementation deleted
  // by id alone after the await, which would delete the NEW registration
  // once A's stale unhealthy result came back, even though B was never
  // checked this sweep and is perfectly healthy.
  registerProvider("sweep-swap", { label: "B (healthy)", baseUrl: healthyUrl });

  await sweeping;

  assert.ok(listHealthyProviders().some((p) => p.id === "sweep-swap"), "the new registration must survive a sweep that was checking the old one");

  deregisterProvider("sweep-swap");
  await new Promise<void>((resolve) => unhealthy.close(() => resolve()));
  await new Promise<void>((resolve) => healthy.close(() => resolve()));
});

test("registerProvider strips a trailing slash from baseUrl so downstream URL joins never double up", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end();
      return;
    }
    if (req.url === "/search" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ candidates: [] }));
      return;
    }
    // A stray trailing slash would make the real request "//search", which
    // falls through to here instead of matching the exact-match branch above.
    res.writeHead(404).end();
  });

  registerProvider("trailing-slash-test", { label: "Trailing Slash", baseUrl: `${baseUrl}/` });

  const result = await proxyToProvider("trailing-slash-test", "/search", { method: "POST", body: { query: "x" } });
  assert.ok(result, "expected a proxied result");
  assert.equal(result!.status, 201, "a double slash would 404 against this handler -- 201 proves it was stripped");

  deregisterProvider("trailing-slash-test");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("canClaim: a brand-new id, or one that never set a token, stays open to the register key alone", () => {
  assert.equal(canClaim("never-registered", undefined), true);
  registerProvider("no-token-test", { label: "No Token", baseUrl: "http://127.0.0.1:1" });
  assert.equal(canClaim("no-token-test", undefined), true, "no token was ever set for this id");
  deregisterProvider("no-token-test");
});

test("canClaim: an id with a token can only be reclaimed by presenting that same token", () => {
  registerProvider("owned-test", { label: "Owned", baseUrl: "http://127.0.0.1:1", token: "owner-secret" });
  assert.equal(canClaim("owned-test", undefined), false, "no token presented at all");
  assert.equal(canClaim("owned-test", "wrong"), false);
  assert.equal(canClaim("owned-test", ["owner-secret", "owner-secret"]), false, "array header must not coerce into a match");
  assert.equal(canClaim("owned-test", "owner-secret"), true);
  deregisterProvider("owned-test");
});

test("registerProvider refuses the reserved id regardless of call site", () => {
  assert.equal(registerProvider(RESERVED_PROVIDER_ID, { label: "hijack", baseUrl: "http://127.0.0.1:1" }), false);
  assert.ok(!listHealthyProviders().some((p) => p.id === RESERVED_PROVIDER_ID));
});

test("listHealthyProviders never exposes a provider's token", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    res.writeHead(200).end();
  });
  registerProvider("secret-test", { label: "Secret Test", baseUrl, token: "should-not-leak" });

  const alive = await listHealthyProviders();
  const entry = alive.find((p) => p.id === "secret-test") as unknown as Record<string, unknown>;
  assert.ok(entry);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "token"), false);

  deregisterProvider("secret-test");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("checkRegisterKey: unset env means the feature doesn't exist, independent of the header", () => {
  assert.equal(checkRegisterKey("anything", undefined), "not-enabled");
  assert.equal(checkRegisterKey(undefined, undefined), "not-enabled");
});

test("checkRegisterKey: set env requires an exact header match, nothing else gets in", () => {
  assert.equal(checkRegisterKey("s3cret", "s3cret"), "ok");
  assert.equal(checkRegisterKey("wrong", "s3cret"), "unauthorized");
  assert.equal(checkRegisterKey(undefined, "s3cret"), "unauthorized");
  assert.equal(checkRegisterKey(["s3cret", "s3cret"], "s3cret"), "unauthorized", "an array header (repeated header) must not coerce into a match");
});
