import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mockApi } from "./mock/plugin";

// HOKAGO_MOCK=1 (`pnpm dev:web:mock`): serve API_PATHS from mock/fixtures.ts
// instead of proxying — frontend work with no docker stack running.
const MOCK = process.env.HOKAGO_MOCK === "1";
const API_ORIGIN = process.env.HOKAGO_API_ORIGIN ?? "http://localhost:3000";

// : require-corp is the default; toggling HOKAGO_COEP=credentialless
// switches the fallback on so both can be demonstrated against the same page.
const coep = process.env.HOKAGO_COEP === "credentialless" ? "credentialless" : "require-corp";

// Everything apps/api serves that this page needs — proxied so the browser
// sees them as same-origin, mirroring the production reverse-proxy topology
// (/: "the browser only ever loads fonts/artwork from our own origin").
const API_PATHS = [
  "/playback",
  "/media-files",
  "/fonts",
  "/artwork",
  "/avatars",
  "/health",
  "/auth",
  "/setup",
  "/profiles",
  "/continue-watching",
  "/libraries",
  "/media-items",
  "/home",
  "/external-artwork",
  "/watch-state",
  "/parties",
  "/downloads",
  "/acquire",
  "/metadata",
  "/admin/queues",
  "/admin-api",
];

export default defineConfig({
  plugins: [react(), tailwindcss(), MOCK && mockApi(API_PATHS)],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": coep,
    },
    proxy: MOCK
      ? undefined
      : {
          ...Object.fromEntries(API_PATHS.map((p) => [p, { target: API_ORIGIN, changeOrigin: true }])),
          "/ws": { target: API_ORIGIN.replace("http", "ws"), ws: true, changeOrigin: true },
        },
  },
});
