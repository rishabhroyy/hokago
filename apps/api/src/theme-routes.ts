import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@hokago/db";
import { validateTheme } from "@hokago/theme";

const db = new PrismaClient();

/** §15 — theme list/detail (unauthenticated, tokens aren't sensitive) + validated import (§1.1). */
export async function registerThemeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/themes", async () => {
    return db.theme.findMany({
      select: { id: true, slug: true, name: true, colorScheme: true, source: true },
      orderBy: { name: "asc" },
    });
  });

  app.get<{ Params: { id: string } }>("/themes/:id", async (req, reply) => {
    const theme = await db.theme.findUnique({ where: { id: req.params.id } });
    if (!theme) return reply.code(404).send({ error: "theme not found" });
    return theme;
  });

  // Which fonts this theme's tokens need (§1.1, §15) — same shape as the
  // media-file font list JASSUB already consumes, so the client-side
  // @font-face injection logic is identical for both.
  app.get<{ Params: { id: string } }>("/themes/:id/fonts", async (req, reply) => {
    const links = await db.themeFont.findMany({
      where: { themeId: req.params.id },
      include: { font: true },
    });
    return links.map((l) => ({
      hash: l.font.hash,
      family: l.font.family,
      weight: l.font.weight,
      style: l.font.style,
      url: `/fonts/${l.font.hash}`,
    }));
  });

  // The wordmark face (§1) is fixed brand identity, not a swappable
  // font.wordmark token — decoupled from ThemeFont linking so it's always
  // available regardless of which theme is active.
  app.get("/fonts/wordmark", async () => {
    const fonts = await db.font.findMany({
      where: { family: "Zen Maru Gothic", path: { contains: "wordmark/" } },
    });
    return fonts.map((f) => ({
      hash: f.hash,
      family: f.family,
      weight: f.weight,
      style: f.style,
      url: `/fonts/${f.hash}`,
    }));
  });

  // Drop-in theme bundles land here eventually (§1.1) — for now, a validated
  // JSON body. Never partially applied: reject entirely or accept entirely.
  app.post<{ Body: unknown }>("/themes/import", { preHandler: app.authenticate }, async (req, reply) => {
    const result = validateTheme(req.body);
    if (!result.ok) return reply.code(400).send({ error: "invalid theme", details: result.errors });

    const { manifest } = result;
    const theme = await db.theme.upsert({
      where: { slug: manifest.slug },
      create: {
        slug: manifest.slug,
        name: manifest.name,
        source: "IMPORTED",
        colorScheme: manifest.colorScheme.toUpperCase() as "DARK" | "LIGHT",
        tokens: manifest.tokens,
      },
      update: {
        name: manifest.name,
        source: "IMPORTED",
        colorScheme: manifest.colorScheme.toUpperCase() as "DARK" | "LIGHT",
        tokens: manifest.tokens,
      },
    });
    return reply.code(201).send(theme);
  });
}
