import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";

import { registerProvider, deregisterProvider, listHealthyProviders, proxyToProvider } from "./acquire-provider-registry.js";

async function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("unexpected server address");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

test("register -> list -> health-fail auto-drops -> proxy 404s", async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });

  registerProvider("drop-test", { label: "Drop Test", baseUrl });
  const alive = await listHealthyProviders();
  assert.ok(alive.some((p) => p.id === "drop-test"), "healthy provider should be listed");

  // Server goes away -- next health check must fail and drop it.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const afterDeath = await listHealthyProviders();
  assert.ok(!afterDeath.some((p) => p.id === "drop-test"), "dead provider should be dropped from the list");

  const proxied = await proxyToProvider("drop-test", "/search", { method: "POST", body: { query: "x" } });
  assert.equal(proxied, null, "a dropped provider must 404 (proxyToProvider returns null)");

  deregisterProvider("drop-test");
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
