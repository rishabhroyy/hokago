import { PrismaClient } from "@hokago/db";
import { getConnection, Queue, QUEUE_NAMES, scanJobId, JOB_FAILURE_THRESHOLD } from "@hokago/queue";
import {
  AdminSummary,
  AdminLibrary,
  AdminLibraryParams,
  AdminLibraryCreateBody,
  AdminLibraryUpdateBody,
  AdminScanResponse,
  AdminAccount,
  AdminAccountParams,
  AdminAccountCreateBody,
  AdminAccountUpdateBody,
  AdminAccountResponse,
  AdminDeletedResponse,
  AdminInvite,
  AdminInviteParams,
  AdminSession,
  ServerSettings,
  ServerSettingsUpdateBody,
  AttentionItem,
  AdminHwaccelStatus,
  ErrorResponse,
} from "@hokago/contract/admin";
import { CreateInviteBody, InviteResponse, RevokedResponse } from "@hokago/contract/auth";
import { getHwaccel, hwaccelStatus } from "@hokago/ffmpeg/hwaccel";
import { hashPassword, generateOpaqueToken } from "./auth.js";
import type { ZodFastifyInstance } from "./fastify-zod.js";
import { queueSummaries } from "./admin-routes.js";

const db = new PrismaClient();

const connection = getConnection();
// Same deterministic-jobId argument as the worker's scanQueue: the libraryId
// is the jobId, so a *kept* failed/completed job would permanently block any
// later re-enqueue for that library (add with an existing id returns the old
// job without re-adding to wait). Drop both terminal states so a rescan can
// never silently no-op against a stale hash.
const scanQueue = new Queue(QUEUE_NAMES.SCAN, {
  connection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
});

/**
 * enqueueScan with the worker's deterministic jobId. The jobId is the
 * libraryId, so a *kept* job — in any state — makes `add` return the existing
 * job instead of enqueueing a fresh one (a silent no-op). removeOnComplete /
 * removeOnFail drop terminal (completed/failed) jobs, but a job stuck in a
 * live state (waiting/active/stalled — a crashed worker, an interrupted scan)
 * persists forever and would block every later manual rescan *and* the boot
 * reconciler's re-enqueue. Force a fresh scan: drop whatever job is current
 * for the library, then enqueue anew.
 */
async function enqueueScan(libraryId: string, mode: "light" | "heavy" = "light"): Promise<void> {
  const jobId = scanJobId(libraryId);
  await scanQueue.remove(jobId).catch(() => {});
  await scanQueue.add(QUEUE_NAMES.SCAN, { libraryId, mode }, { jobId });
}

/** /admin-api — the management backend: dashboard summary, libraries, accounts,
 *  invites, sessions, settings, provider toggles, and the attention list. */
export async function registerAdminMgmtRoutes(app: ZodFastifyInstance): Promise<void> {
  const gate = { preHandler: [app.authenticate, app.requireAdmin] };

  // ── Summary ────────────────────────────────────────────────────────────────
  app.get("/admin-api/summary", { ...gate, schema: { response: { 200: AdminSummary } } }, async () => {
    const [libraries, itemGroups, mediaAgg, artworkAgg, fonts, accounts, profiles, activeSessions, runningTranscodes, needsAttention, lastScan] =
      await Promise.all([
        db.library.count(),
        db.mediaItem.groupBy({ by: ["kind"], _count: { _all: true } }),
        db.mediaFile.aggregate({ _sum: { sizeBytes: true } }),
        db.artwork.aggregate({ _sum: { sizeBytes: true } }),
        db.font.count(),
        db.account.count(),
        db.profile.count(),
        db.playbackSession.count({ where: { endedAt: null } }),
        db.transcodeJob.count({ where: { state: "RUNNING" } }),
        db.mediaItem.count({ where: { state: "NEEDS_ATTENTION" } }),
        db.library.findFirst({ where: { lastScanAt: { not: null } }, orderBy: { lastScanAt: "desc" }, select: { lastScanAt: true } }),
      ]);

    const queues = await queueSummaries();

    const itemKinds: Record<string, number> = {};
    let items = 0;
    for (const g of itemGroups) {
      itemKinds[g.kind] = g._count._all;
      items += g._count._all;
    }

    return {
      libraries,
      items,
      itemKinds,
      mediaBytes: Number(mediaAgg._sum.sizeBytes ?? 0n),
      mediaFiles: await db.mediaFile.count(),
      artworkBytes: Number(artworkAgg._sum.sizeBytes ?? 0n),
      artworkFiles: await db.artwork.count(),
      fonts,
      accounts,
      profiles,
      activeSessions,
      runningTranscodes,
      needsAttention,
      lastScanAt: lastScan?.lastScanAt ?? null,
      queues,
    };
  });

  // ── Libraries ──────────────────────────────────────────────────────────────
  /** Sum of MediaFile bytes under a library (raw join — Prisma can't group across relations). */
  async function libraryStorageBytes(libraryId: string): Promise<number> {
    // PG17 dropped the implicit uuid = text operator — bind the id with an
    // explicit cast or every PATCH /admin-api/libraries/:id 500s.
    const rows = await db.$queryRaw<{ bytes: bigint }[]>`
      SELECT COALESCE(SUM(f."sizeBytes"), 0) AS bytes
      FROM media_files f
      JOIN media_items i ON i.id = f."mediaItemId"
      WHERE i."libraryId" = ${libraryId}::uuid`;
    return Number(rows[0]?.bytes ?? 0n);
  }

  app.get("/admin-api/libraries", { ...gate, schema: { response: { 200: AdminLibrary.array() } } }, async () => {
    const libs = await db.library.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { items: true } } },
    });
    const storageRows = await db.$queryRaw<{ libraryId: string; bytes: bigint }[]>`
      SELECT i."libraryId" AS "libraryId", COALESCE(SUM(f."sizeBytes"), 0) AS bytes
      FROM media_files f
      JOIN media_items i ON i.id = f."mediaItemId"
      GROUP BY i."libraryId"`;
    const storage = new Map(storageRows.map((r) => [r.libraryId, Number(r.bytes)]));
    // Live scan progress for every library from the BullMQ scan queue — the
    // deterministic jobId (scanJobId) makes getJob a cheap per-library lookup.
    const scanProgress = new Map<string, { doneDirs: number; totalDirs: number }>();
    for (const lib of libs) {
      const job = await scanQueue.getJob(scanJobId(lib.id));
      if (job && job.finishedOn == null) {
        const p = job.progress as { doneDirs?: number; totalDirs?: number } | number | undefined;
        if (p && typeof p === "object" && typeof p.totalDirs === "number") {
          scanProgress.set(lib.id, { doneDirs: p.doneDirs ?? 0, totalDirs: p.totalDirs });
        }
      }
    }
    return libs.map(({ _count, ...lib }) => ({
      ...lib,
      mediaKinds: lib.mediaKinds as AdminLibrary["mediaKinds"],
      providerOrder: lib.providerOrder as AdminLibrary["providerOrder"],
      itemCount: _count.items,
      storageBytes: storage.get(lib.id) ?? 0,
      scanProgress: scanProgress.get(lib.id) ?? null,
    }));
  });

  app.post(
    "/admin-api/libraries",
    { ...gate, schema: { body: AdminLibraryCreateBody, response: { 201: AdminLibrary, 409: ErrorResponse } } },
    async (req, reply) => {
      try {
        const lib = await db.library.create({
          data: {
            name: req.body.name,
            rootPath: req.body.rootPath,
            contentProfile: req.body.contentProfile ?? "GENERAL",
            mediaKinds: req.body.mediaKinds ?? ["MOVIE", "SERIES"],
            providerOrder: req.body.providerOrder ?? [],
            scanMode: req.body.scanMode ?? "WATCH_AND_PERIODIC",
            writable: req.body.writable ?? false,
            composeAllPosters: req.body.composeAllPosters ?? false,
            enabled: req.body.enabled ?? true,
            hiddenFromHome: req.body.hiddenFromHome ?? false,
          },
        });
        if (lib.enabled) await enqueueScan(lib.id).catch(() => {});
        const created: AdminLibrary = {
          id: lib.id,
          name: lib.name,
          rootPath: lib.rootPath,
          contentProfile: lib.contentProfile as AdminLibrary["contentProfile"],
          mediaKinds: lib.mediaKinds as AdminLibrary["mediaKinds"],
          providerOrder: lib.providerOrder as AdminLibrary["providerOrder"],
          scanMode: lib.scanMode as AdminLibrary["scanMode"],
          writable: lib.writable,
          composeAllPosters: lib.composeAllPosters,
          enabled: lib.enabled,
          hiddenFromHome: lib.hiddenFromHome,
          lastScanAt: lib.lastScanAt,
          itemCount: 0,
          storageBytes: 0,
          scanProgress: null,
          createdAt: lib.createdAt,
          updatedAt: lib.updatedAt,
        };
        return reply.code(201).send(created);
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          return reply.code(409).send({ error: "rootPath already used by another library" });
        }
        throw err;
      }
    },
  );

  app.patch(
    "/admin-api/libraries/:id",
    { ...gate, schema: { params: AdminLibraryParams, body: AdminLibraryUpdateBody, response: { 200: AdminLibrary, 404: ErrorResponse } } },
    async (req, reply) => {
      const existing = await db.library.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: "library not found" });
      const lib = await db.library.update({ where: { id: req.params.id }, data: req.body });
      const [itemCount, storageBytes] = await Promise.all([
        db.mediaItem.count({ where: { libraryId: lib.id } }),
        libraryStorageBytes(lib.id),
      ]);
      const job = await scanQueue.getJob(scanJobId(lib.id));
      let scanProgress: { doneDirs: number; totalDirs: number } | null = null;
      if (job && job.finishedOn == null) {
        const p = job.progress as { doneDirs?: number; totalDirs?: number } | number | undefined;
        if (p && typeof p === "object" && typeof p.totalDirs === "number") {
          scanProgress = { doneDirs: p.doneDirs ?? 0, totalDirs: p.totalDirs };
        }
      }
      return { ...lib, mediaKinds: lib.mediaKinds as AdminLibrary["mediaKinds"], providerOrder: lib.providerOrder as AdminLibrary["providerOrder"], itemCount, storageBytes, scanProgress };
    },
  );

  app.delete(
    "/admin-api/libraries/:id",
    { ...gate, schema: { params: AdminLibraryParams, response: { 200: AdminDeletedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const existing = await db.library.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: "library not found" });
      await db.library.delete({ where: { id: req.params.id } });
      return { deleted: true };
    },
  );

  app.post(
    "/admin-api/libraries/:id/scan",
    { ...gate, schema: { params: AdminLibraryParams, response: { 200: AdminScanResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const lib = await db.library.findUnique({ where: { id: req.params.id } });
      if (!lib) return reply.code(404).send({ error: "library not found" });
      // Manual trigger is heavy by default (fixes + full I/O); callers can pass mode=light for lightweight periodic parity.
      const requested = (req.query as { mode?: string })?.mode ?? (req.body as { mode?: string })?.mode;
      await enqueueScan(lib.id, requested === "light" ? "light" : "heavy");
      return { enqueued: true };
    },
  );

  app.post(
    "/admin-api/libraries/:id/scan/light",
    { ...gate, schema: { params: AdminLibraryParams, response: { 200: AdminScanResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const lib = await db.library.findUnique({ where: { id: req.params.id } });
      if (!lib) return reply.code(404).send({ error: "library not found" });
      await enqueueScan(lib.id, "light");
      return { enqueued: true };
    },
  );

  // ── Accounts ───────────────────────────────────────────────────────────────
  app.get("/admin-api/accounts", { ...gate, schema: { response: { 200: AdminAccount.array() } } }, async () => {
    const accounts = await db.account.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { profiles: true, sessions: true } } },
    });
    return accounts.map(({ passwordHash, _count, ...account }) => ({
      ...account,
      profileCount: _count.profiles,
      sessionCount: _count.sessions,
    }));
  });

  app.post(
    "/admin-api/accounts",
    { ...gate, schema: { body: AdminAccountCreateBody, response: { 201: AdminAccountResponse, 409: ErrorResponse } } },
    async (req, reply) => {
      const existing = await db.account.findUnique({ where: { username: req.body.username } });
      if (existing) return reply.code(409).send({ error: "username taken" });
      const passwordHash = await hashPassword(req.body.password);
      const account = await db.account.create({
        data: { username: req.body.username, passwordHash, isAdmin: req.body.isAdmin ?? false },
      });
      return reply.code(201).send({ id: account.id });
    },
  );

  app.patch(
    "/admin-api/accounts/:id",
    { ...gate, schema: { params: AdminAccountParams, body: AdminAccountUpdateBody, response: { 200: AdminAccountResponse, 404: ErrorResponse, 400: ErrorResponse } } },
    async (req, reply) => {
      const account = await db.account.findUnique({ where: { id: req.params.id } });
      if (!account) return reply.code(404).send({ error: "account not found" });
      // Never let an admin lock themselves out: no self-disable, no self-demotion.
      if (req.params.id === req.accountId && (req.body.disabled || req.body.isAdmin === false)) {
        return reply.code(400).send({ error: "cannot disable or demote your own account" });
      }
      const data: Record<string, unknown> = {};
      if (req.body.isAdmin !== undefined) data.isAdmin = req.body.isAdmin;
      if (req.body.disabled !== undefined) data.disabled = req.body.disabled;
      if (req.body.password) data.passwordHash = await hashPassword(req.body.password);
      const updated = await db.account.update({ where: { id: req.params.id }, data });
      return { id: updated.id };
    },
  );

  app.delete(
    "/admin-api/accounts/:id",
    { ...gate, schema: { params: AdminAccountParams, response: { 200: AdminDeletedResponse, 404: ErrorResponse, 400: ErrorResponse } } },
    async (req, reply) => {
      const account = await db.account.findUnique({ where: { id: req.params.id } });
      if (!account) return reply.code(404).send({ error: "account not found" });
      if (req.params.id === req.accountId) return reply.code(400).send({ error: "cannot delete your own account" });
      await db.account.delete({ where: { id: req.params.id } });
      return { deleted: true };
    },
  );

  // ── Invites ────────────────────────────────────────────────────────────────
  app.get("/admin-api/invites", { ...gate, schema: { response: { 200: AdminInvite.array() } } }, async () => {
    const invites = await db.invite.findMany({
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { username: true } } },
    });
    return invites.map((invite) => ({
      id: invite.id,
      code: invite.code,
      createdBy: invite.createdBy.username,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
    }));
  });

  app.post(
    "/admin-api/invites",
    { ...gate, schema: { body: CreateInviteBody.optional(), response: { 200: InviteResponse } } },
    async (req) => {
      const code = generateOpaqueToken().slice(0, 12);
      const expiresAt = req.body?.expiresInDays
        ? new Date(Date.now() + req.body.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await db.invite.create({ data: { code, createdById: req.accountId!, expiresAt } });
      return { code: invite.code, expiresAt: invite.expiresAt };
    },
  );

  app.delete(
    "/admin-api/invites/:id",
    { ...gate, schema: { params: AdminInviteParams, response: { 200: AdminDeletedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const invite = await db.invite.findUnique({ where: { id: req.params.id } });
      if (!invite) return reply.code(404).send({ error: "invite not found" });
      await db.invite.delete({ where: { id: req.params.id } });
      return { deleted: true };
    },
  );

  // ── Sessions ───────────────────────────────────────────────────────────────
  app.get("/admin-api/sessions", { ...gate, schema: { response: { 200: AdminSession.array() } } }, async () => {
    const sessions = await db.session.findMany({
      orderBy: { createdAt: "desc" },
      include: { account: { select: { username: true } } },
    });
    return sessions.map((session) => ({
      id: session.id,
      username: session.account.username,
      device: session.device,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    }));
  });

  app.post(
    "/admin-api/sessions/:id/revoke",
    { ...gate, schema: { params: AdminInviteParams, response: { 200: RevokedResponse, 404: ErrorResponse } } },
    async (req, reply) => {
      const session = await db.session.findUnique({ where: { id: req.params.id } });
      if (!session) return reply.code(404).send({ error: "session not found" });
      await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return { revoked: true };
    },
  );

  // ── Server settings ────────────────────────────────────────────────────────
  app.get("/admin-api/settings", { ...gate, schema: { response: { 200: ServerSettings } } }, async () => {
    const settings = await db.serverSetting.upsert({
      where: { id: "singleton" },
      create: { id: "singleton" },
      update: {},
    });
    return settings;
  });

  app.put(
    "/admin-api/settings",
    { ...gate, schema: { body: ServerSettingsUpdateBody, response: { 200: ServerSettings } } },
    async (req) => {
      const settings = await db.serverSetting.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", ...req.body },
        update: req.body,
      });
      return settings;
    },
  );

  // ── Hardware acceleration status (read-only — config lives in env/compose) ──
  app.get("/admin-api/hwaccel", { ...gate, schema: { response: { 200: AdminHwaccelStatus } } }, async () => {
    return hwaccelStatus(await getHwaccel());
  });

  // ── Attention ──────────────────────────────────────────────────────────────
  app.get("/admin-api/attention", { ...gate, schema: { response: { 200: AttentionItem.array() } } }, async () => {
    const items = await db.mediaItem.findMany({
      where: {
        OR: [
          { state: "NEEDS_ATTENTION" },
          { jobFailures: { some: { attempts: { gte: JOB_FAILURE_THRESHOLD } } } },
        ],
      },
      include: {
        library: { select: { name: true } },
        jobFailures: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      libraryName: item.library.name,
      state: item.state,
      confidence: item.confidence,
      failures: item.jobFailures.map((f) => ({
        jobType: f.jobType,
        attempts: f.attempts,
        lastError: f.lastError,
        lastFailedAt: f.lastFailedAt,
      })),
    }));
  });
}