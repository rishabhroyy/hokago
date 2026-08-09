import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type { ZodFastifyInstance } from "./fastify-zod.js";

/**
 * Serves the built SPA from the API container (Immich's `IMMICH_WEB_ROOT`
 * model) — one server, no nginx, no proxy. Enabled only when
 * HOKAGO_WEB_ROOT points at the baked-in `apps/web/dist`; in dev the vite
 * server on the host plays this role instead.
 *
 * Registered AFTER every API route: exact/param routes win in Fastify's
 * radix tree, so the wildcard here only ever sees paths the API doesn't own.
 * Real files (hashed assets) are served as-is; anything else falls through
 * to index.html — the SPA deep-link behavior the nginx `try_files` used to
 * provide. COOP/COEP are the JASSUB contract (must be same-origin); the
 * old nginx proxy duplicated these headers, here they live next to the code
 * that needs them.
 */
export async function registerWebRoutes(app: ZodFastifyInstance): Promise<void> {
  const webRoot = process.env.HOKAGO_WEB_ROOT;
  if (!webRoot) return;

  app.get<{ Params: { "*": string } }>("/*", async (req, reply) => {
    const rel = decodeURIComponent(req.params["*"] ?? "");
    const filePath = path.join(webRoot, rel === "" ? "index.html" : rel);
    // Guard against path traversal above webRoot (vite hashes make this
    // purely defensive, but a `/../../` should never escape the root).
    if (!filePath.startsWith(webRoot)) {
      return reply.code(404).send({ error: "not found" });
    }

    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Embedder-Policy", "require-corp");

    const target = existsSync(filePath) && statSync(filePath).isFile() ? filePath : path.join(webRoot, "index.html");
    return reply.sendFile(path.basename(target), path.dirname(target), {
      maxAge: rel.startsWith("assets/") ? 31_536_000 : 0,
    });
  });
}
