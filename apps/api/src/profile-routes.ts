import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@hokago/db";

const db = new PrismaClient();

interface CreateProfileBody {
  name: string;
  avatarPath?: string;
  themeId?: string;
  maturityRating?: string;
}

interface UpdateProfileBody {
  name?: string;
  avatarPath?: string | null;
  themeId?: string | null;
  maturityRating?: string | null;
}

/** §7.1 — multiple profiles per account, theme + maturity rating stored per profile. */
export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profiles", { preHandler: app.authenticate }, async (req) => {
    return db.profile.findMany({ where: { accountId: req.accountId }, orderBy: { createdAt: "asc" } });
  });

  app.get<{ Params: { id: string } }>("/profiles/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const profile = await db.profile.findUnique({ where: { id: req.params.id } });
    if (!profile || profile.accountId !== req.accountId) {
      return reply.code(404).send({ error: "profile not found" });
    }
    return profile;
  });

  app.post<{ Body: CreateProfileBody }>("/profiles", { preHandler: app.authenticate }, async (req, reply) => {
    const { name, avatarPath, themeId, maturityRating } = req.body;
    const profile = await db.profile.create({
      data: { accountId: req.accountId!, name, avatarPath, themeId, maturityRating },
    });
    return reply.code(201).send(profile);
  });

  app.patch<{ Params: { id: string }; Body: UpdateProfileBody }>(
    "/profiles/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const existing = await db.profile.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.accountId !== req.accountId) {
        return reply.code(404).send({ error: "profile not found" });
      }
      const profile = await db.profile.update({ where: { id: req.params.id }, data: req.body });
      return profile;
    },
  );

  app.delete<{ Params: { id: string } }>("/profiles/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const existing = await db.profile.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.accountId !== req.accountId) {
      return reply.code(404).send({ error: "profile not found" });
    }
    await db.profile.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });

  // Theme tokens aren't sensitive (colors/fonts) — left unauthenticated so the
  // player/profile-select screens can resolve a profile's theme before login
  // state is necessarily wired up client-side. Full switcher UI is Step 10;
  // this is just what makes Profile.themeId take effect at all.
  app.get<{ Params: { id: string } }>("/themes/:id", async (req, reply) => {
    const theme = await db.theme.findUnique({ where: { id: req.params.id } });
    if (!theme) return reply.code(404).send({ error: "theme not found" });
    return theme;
  });
}
