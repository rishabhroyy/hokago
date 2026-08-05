import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@hokago/db";
import type { ZodFastifyInstance } from "./fastify-zod.js";

const db = new PrismaClient();

function avatarStoreDir(): string {
  return path.join(process.env.HOKAGO_CONFIG_DIR ?? "./data/config", "avatars");
}

const AVATAR_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_AVATAR_BYTES = 8 * 1024 * 1024; // bodyLimit on the upload route

/**
 * Magic-byte sniffing only — no image library needed for avatars. jpeg/png/
 * webp/gif cover every browser picker; anything else is rejected outright.
 */
function sniffImageExt(bytes: Buffer): string | null {
  if (bytes.length < 16) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Profile pictures: raw binary POST (application/octet-stream, no multipart
 * dependency), content-addressed like the artwork store, served from our own
 * origin only — same hard rule as fonts/artwork. The upload writes the file
 * and owns `Profile.avatarPath`; clients never set a path directly.
 */
export async function registerAvatarRoutes(app: ZodFastifyInstance): Promise<void> {
  app.post<{ Body: Buffer }>(
    "/avatars",
    { preHandler: app.authenticate, bodyLimit: MAX_AVATAR_BYTES },
    async (req, reply) => {
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length < 16) {
        return reply.code(400).send({ error: "empty or invalid image body" });
      }
      const ext = sniffImageExt(bytes);
      if (!ext) {
        return reply.code(415).send({ error: "unsupported image — use jpeg, png, webp, or gif" });
      }

      const profile = await db.profile.findFirst({
        where: { accountId: req.accountId },
        orderBy: { createdAt: "asc" },
      });
      if (!profile) return reply.code(400).send({ error: "no profile on this account yet" });

      const hash = createHash("sha256").update(bytes).digest("hex");
      const fileName = `${hash}.${ext}`;
      const storeDir = avatarStoreDir();
      await mkdir(storeDir, { recursive: true });
      await writeFile(path.join(storeDir, fileName), bytes);

      const avatarPath = `/avatars/${fileName}`;
      await db.profile.update({ where: { id: profile.id }, data: { avatarPath } });

      return { avatarPath };
    },
  );

  // Same hash-keyed immutable-cache shape as /fonts/:hash. basename() keeps a
  // hand-crafted :hash from escaping the avatars dir.
  app.get<{ Params: { hash: string } }>("/avatars/:hash", async (req, reply) => {
    const name = path.basename(req.params.hash);
    const filePath = path.join(avatarStoreDir(), name);
    if (!existsSync(filePath)) return reply.code(404).send({ error: "avatar not found" });

    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(AVATAR_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream");
    return reply.send(createReadStream(filePath));
  });
}
