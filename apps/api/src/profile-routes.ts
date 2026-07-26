import { PrismaClient } from "@hokago/db";
import {
  Profile,
  ProfileParams,
  CreateProfileBody,
  UpdateProfileBody,
  NotFoundError,
} from "@hokago/contract/profiles";
import { z } from "zod";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

/** §7.1 — multiple profiles per account, maturity rating stored per profile. */
export async function registerProfileRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    "/profiles",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(Profile) } } },
    async (req) => {
      return db.profile.findMany({ where: { accountId: req.accountId }, orderBy: { createdAt: "asc" } });
    },
  );

  app.get(
    "/profiles/:id",
    { preHandler: app.authenticate, schema: { params: ProfileParams, response: { 200: Profile, 404: NotFoundError } } },
    async (req, reply) => {
      const profile = await db.profile.findUnique({ where: { id: req.params.id } });
      if (!profile || profile.accountId !== req.accountId) {
        return reply.code(404).send({ error: "profile not found" });
      }
      return profile;
    },
  );

  app.post(
    "/profiles",
    { preHandler: app.authenticate, schema: { body: CreateProfileBody, response: { 201: Profile } } },
    async (req, reply) => {
      const { name, avatarPath, maturityRating } = req.body;
      const profile = await db.profile.create({
        data: { accountId: req.accountId!, name, avatarPath, maturityRating },
      });
      return reply.code(201).send(profile);
    },
  );

  app.patch(
    "/profiles/:id",
    {
      preHandler: app.authenticate,
      schema: { params: ProfileParams, body: UpdateProfileBody, response: { 200: Profile, 404: NotFoundError } },
    },
    async (req, reply) => {
      const existing = await db.profile.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.accountId !== req.accountId) {
        return reply.code(404).send({ error: "profile not found" });
      }
      const profile = await db.profile.update({ where: { id: req.params.id }, data: req.body });
      return profile;
    },
  );

  app.delete(
    "/profiles/:id",
    {
      preHandler: app.authenticate,
      schema: { params: ProfileParams, response: { 204: z.null(), 404: NotFoundError } },
    },
    async (req, reply) => {
      const existing = await db.profile.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.accountId !== req.accountId) {
        return reply.code(404).send({ error: "profile not found" });
      }
      await db.profile.delete({ where: { id: req.params.id } });
      return reply.code(204).send(null);
    },
  );
}
