// `pnpm dev:web:mock` — the web app against canned data, no docker/api/db.
// Vite middleware answers every API path from fixtures.ts; anything unmocked
// gets a 404 so the UI shows its degraded state rather than hanging. Playback
// isn't mocked (no ffmpeg) — that one still needs the real stack.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import * as fx from "./fixtures";

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// The client only decodes the payload (exp, isAdmin) — the signature is never checked locally.
const jwt = () => `${b64url({ alg: "none" })}.${b64url({ sub: "a1", isAdmin: true, exp: Math.floor(Date.now() / 1000) + 30 * 86_400 })}.mock`;
const tokens = () => ({ accessToken: jwt(), refreshToken: "mock-refresh", sessionId: "s1", deviceId: null });

const FONT_DIR = path.resolve(import.meta.dirname, "../../../packages/fonts/node_modules/@fontsource");
const FONTS = [
  ["plus-jakarta-sans", "Plus Jakarta Sans", [400, 500, 600, 700, 800]],
  ["zen-maru-gothic", "Zen Maru Gothic", [500, 700, 900]],
  ["jetbrains-mono", "JetBrains Mono", [400, 500]],
] as const;
const fontFile = (pkg: string, weight: number) => path.join(FONT_DIR, pkg, "files", `${pkg}-latin-${weight}-normal.woff2`);

// Pastel pairs from tailwind.config.ts (p1a/p1b … p6a/p6b).
const PASTELS = [["#F4A98C", "#EE8E6C"], ["#ED9DAE", "#E2879A"], ["#EFCB79", "#E4B457"], ["#A9CDA0", "#89B683"], ["#9BCBE0", "#78B3D0"], ["#F09E86", "#E27862"]];
function artSvg(shape: string, id: string): string {
  const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [a, b] = PASTELS[h % PASTELS.length];
  const [c] = PASTELS[(h >>> 3) % PASTELS.length];
  const [w, ht] = shape === "poster" ? [600, 900] : [1600, 900];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${ht}"><defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${ht}" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${ht * 0.34}" r="${ht * 0.22}" fill="${c}" opacity=".55"/><path d="M0 ${ht * 0.72} Q ${w * 0.35} ${ht * 0.6} ${w} ${ht * 0.76} V ${ht} H 0 Z" fill="#35302B" opacity=".18"/></svg>`;
}

type Handler = (m: RegExpMatchArray, url: URL) => unknown;
const routes: [method: string, re: RegExp, handler: Handler][] = [
  ["GET", /^\/health$/, () => ({ status: "ok", version: "mock" })],
  ["GET", /^\/setup\/state$/, () => ({ setupRequired: process.env.HOKAGO_MOCK_SETUP === "1" })],
  ["POST", /^\/setup\/complete$/, () => ({ ok: true, ...tokens() })],
  ["POST", /^\/auth\/(login|device)$/, tokens],
  ["POST", /^\/auth\/refresh$/, () => ({ accessToken: jwt() })],
  ["POST", /^\/auth\/logout$/, () => ({ revoked: true })],
  ["GET", /^\/auth\/(sessions|devices)$/, () => []],
  ["GET", /^\/profiles$/, () => fx.profiles],
  ["GET", /^\/home$/, () => fx.home],
  ["GET", /^\/continue-watching$/, () => fx.continueWatching],
  ["GET", /^\/libraries$/, () => fx.libraries],
  ["GET", /^\/libraries\/([^/]+)\/items$/, (m) => fx.libraryItems[m[1]] ?? []],
  ["GET", /^\/media-items\/([^/]+)$/, (m) => fx.detail(m[1])],
  ["GET", /^\/media-items\/([^/]+)\/files$/, () => fx.files],
  ["GET", /^\/watch-history$/, () => []],
  ["POST", /^\/watch-state\//, () => ({ ok: true })],
  ["GET", /^\/downloads$/, () => []],
  ["GET", /^\/acquire\/providers$/, () => []],
  ["GET", /^\/acquire\/(existing|[^/]+\/downloads)$/, () => []],
  ["GET", /^\/metadata\/search$/, () => []],
  ["GET", /^\/admin-api\/summary$/, () => fx.admin.summary],
  ["GET", /^\/admin-api\/libraries$/, () => fx.admin.libraries],
  ["GET", /^\/admin-api\/accounts$/, () => fx.admin.accounts],
  ["GET", /^\/admin-api\/invites$/, () => fx.admin.invites],
  ["GET", /^\/admin-api\/sessions$/, () => fx.admin.sessions],
  ["GET", /^\/admin-api\/settings$/, () => fx.admin.settings],
  ["GET", /^\/admin-api\/attention$/, () => fx.admin.attention],
  ["GET", /^\/admin-api\/hwaccel$/, () => fx.admin.hwaccel],
  ["GET", /^\/admin\/queues$/, () => fx.admin.queues],
  ["GET", /^\/admin\/queues\/[^/]+\/jobs$/, () => []],
  ["GET", /^\/fonts$/, () => FONTS.flatMap(([pkg, family, weights]) => weights.map((weight) => ({ hash: `${pkg}-${weight}`, family, weight, style: "normal", url: `/fonts/${pkg}-${weight}` })))],
];

export function mockApi(apiPaths: string[]): Plugin {
  return {
    name: "hokago-mock-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://mock");
        const p = url.pathname;
        if (!apiPaths.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return next();

        const send = (status: number, body: string | Buffer, type: string) => {
          res.statusCode = status;
          res.setHeader("Content-Type", type);
          res.end(body);
        };

        const art = p.match(/^\/artwork\/mock\/(poster|backdrop)\/([^/]+)$/);
        if (art) return send(200, artSvg(art[1], art[2]), "image/svg+xml");
        const font = p.match(/^\/fonts\/([a-z-]+)-(\d+)$/);
        if (font && existsSync(fontFile(font[1], +font[2]))) return send(200, readFileSync(fontFile(font[1], +font[2])), "font/woff2");

        for (const [method, re, handler] of routes) {
          const m = p.match(re);
          if (m && req.method === method) {
            const body = handler(m, url);
            if (body == null) return send(404, JSON.stringify({ error: "not found" }), "application/json");
            return send(200, JSON.stringify(body), "application/json");
          }
        }
        // Mutations no fixture covers succeed as no-ops so buttons don't error out.
        if (req.method !== "GET") return send(200, "{}", "application/json");
        server.config.logger.warn(`[mock] unmocked ${req.method} ${p}`, { timestamp: true });
        send(404, JSON.stringify({ error: "not mocked" }), "application/json");
      });
    },
  };
}
