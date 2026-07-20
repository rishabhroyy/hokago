import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@hokago/db";

const db = new PrismaClient();

interface ArtworkRef {
  id: string;
  kind: string;
  priority: number;
}

/** Lowest `priority` wins per kind (§7.6) — sidecar/embedded beat generated. */
function primaryArtworkUrl(artwork: ArtworkRef[], kind: "POSTER" | "BACKDROP"): string | null {
  const best = artwork.filter((a) => a.kind === kind).sort((a, b) => a.priority - b.priority)[0];
  return best ? `/artwork/${best.id}` : null;
}

const cardSelect = {
  id: true,
  kind: true,
  title: true,
  sortTitle: true,
  year: true,
  artwork: { select: { id: true, kind: true, priority: true } },
} as const;

function toCard<T extends { artwork: ArtworkRef[] }>(
  item: T,
): Omit<T, "artwork"> & { posterUrl: string | null; backdropUrl: string | null } {
  const { artwork, ...rest } = item;
  return {
    ...rest,
    posterUrl: primaryArtworkUrl(artwork, "POSTER"),
    backdropUrl: primaryArtworkUrl(artwork, "BACKDROP"),
  };
}

/** §7.3/§7.6 — library browsing and item detail. No route existed before this. */
export async function registerBrowseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/libraries", { preHandler: app.authenticate }, async () => {
    return db.library.findMany({
      where: { enabled: true },
      select: { id: true, name: true, contentProfile: true, mediaKinds: true },
      orderBy: { name: "asc" },
    });
  });

  // Top-level items only (MOVIE/SERIES) — SEASON/EPISODE nest under their
  // parent and are fetched via the item-detail route below.
  app.get<{ Params: { id: string } }>("/libraries/:id/items", { preHandler: app.authenticate }, async (req) => {
    const items = await db.mediaItem.findMany({
      where: { libraryId: req.params.id, parentId: null, kind: { in: ["MOVIE", "SERIES"] } },
      select: cardSelect,
      orderBy: { sortTitle: "asc" },
    });
    return items.map(toCard);
  });

  app.get<{ Params: { id: string } }>("/media-items/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const item = await db.mediaItem.findUnique({
      where: { id: req.params.id },
      include: {
        artwork: { select: { id: true, kind: true, priority: true } },
        children: { select: cardSelect, orderBy: { sortTitle: "asc" } },
        collectionEntries: {
          include: {
            collection: {
              include: {
                artwork: { select: { id: true, kind: true, priority: true } },
                entries: {
                  include: { mediaItem: { select: cardSelect } },
                  orderBy: { releaseOrder: "asc" },
                },
              },
            },
          },
        },
      },
    });
    if (!item) return reply.code(404).send({ error: "media item not found" });

    const { children, collectionEntries, ...rest } = item;
    return {
      ...toCard(rest),
      children: children.map(toCard),
      collections: collectionEntries.map((entry) => ({
        id: entry.collection.id,
        name: entry.collection.name,
        kind: entry.collection.kind,
        posterUrl: primaryArtworkUrl(entry.collection.artwork, "POSTER"),
        relationType: entry.relationType,
        entries: entry.collection.entries.map((e) => ({
          relationType: e.relationType,
          anchor: e.anchor,
          item: toCard(e.mediaItem),
        })),
      })),
    };
  });
}
