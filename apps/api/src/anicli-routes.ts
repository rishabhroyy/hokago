import { PrismaClient } from "@hokago/db";
import { Queue, getConnection, QUEUE_NAMES, anicliJobId, type AnicliDownloadJobData } from "@hokago/queue";
import { z } from "zod";
import type { ZodFastifyInstance } from "./fastify-zod.js";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.js";

const db = new PrismaClient();
const anicliQueue = new Queue<AnicliDownloadJobData>(QUEUE_NAMES.ANICLI, {
  connection: getConnection(),
  defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});
export async function closeAnicliQueue(){ await anicliQueue.close().catch(()=>{}); }

// Guards to never kill hard drive
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_EPISODES = 100;
const QUERY_MAX_LEN = 200;

async function hasFreeSpace(dir: string, needed = MIN_FREE_BYTES): Promise<boolean> {
  try { const s = await statfs(dir); return Number(s.bfree) * Number(s.bsize) > needed; } catch { return true; }
}

export async function registerAnicliRoutes(app: ZodFastifyInstance){
  app.post("/anicli/downloads", { preHandler: app.authenticate }, async (req, reply)=>{
    // admin-only: acquiring internet titles is privileged
    const acct = await db.account.findUnique({ where:{ id: req.accountId! }, select:{ isAdmin:true }});
    if(!acct?.isAdmin) return reply.code(403).send({ error:"admin only"});
    const body = z.object({ libraryId: z.string().uuid(), query: z.string().min(1).max(QUERY_MAX_LEN), episodeRange: z.string().max(20).optional() }).parse(req.body);
    const lib = await db.library.findUnique({ where:{ id: body.libraryId }});
    if(!lib) return reply.code(404).send({ error:"library not found"});
    if(lib.contentProfile !== "ANIME") return reply.code(422).send({ error:"anicli only for ANIME libraries"});
    // disk guard
    const free = await hasFreeSpace(lib.rootPath);
    if(!free) return reply.code(507).send({ error:"insufficient disk space — free up at least 2 GiB"});
    // rate limit: max 3 active per account
    const active = await db.anicliDownload.count({ where:{ accountId: req.accountId!, status:{ in:["QUEUED","SEARCHING","DOWNLOADING","IMPORTING"]}}});
    if(active >= 3) return reply.code(429).send({ error:"too many active downloads (max 3)"});
    // episode range guard
    if(body.episodeRange && !/^\d+(-\d+)?$/.test(body.episodeRange)) return reply.code(422).send({ error:"episodeRange must be like 1-12 or 5"});
    if(body.episodeRange){
      const parts = body.episodeRange.split("-").map(Number);
      const count = parts.length===2 ? parts[1]! - parts[0]! +1 : 1;
      if(count > MAX_EPISODES) return reply.code(422).send({ error:`max ${MAX_EPISODES} episodes per job`});
    }
    const job = await db.anicliDownload.create({ data:{ accountId: req.accountId!, libraryId: body.libraryId, query: body.query.trim(), episodeRange: body.episodeRange ?? null, status:"QUEUED"}});
    await anicliQueue.add(QUEUE_NAMES.ANICLI, { jobId: job.id }, { jobId: anicliJobId(job.id) }).catch(async e=>{
      await db.anicliDownload.update({ where:{ id: job.id }, data:{ status:"FAILED", error: String(e)}});
    });
    return reply.code(201).send(job);
  });

  app.get("/anicli/downloads", { preHandler: app.authenticate }, async (req)=>{
    const rows = await db.anicliDownload.findMany({ where:{ accountId: req.accountId }, orderBy:{ createdAt:"desc"}, take:50 });
    return rows.map(r=>({ ...r, bytesWritten: r.bytesWritten.toString()}));
  });

  app.get("/anicli/downloads/:id", { preHandler: app.authenticate }, async (req, reply)=>{
    const { id } = req.params as { id:string };
    const row = await db.anicliDownload.findUnique({ where:{ id }});
    if(!row || row.accountId !== req.accountId) return reply.code(404).send({ error:"not found"});
    return { ...row, bytesWritten: row.bytesWritten.toString() };
  });

  app.delete("/anicli/downloads/:id", { preHandler: app.authenticate }, async (req, reply)=>{
    const { id } = req.params as { id:string };
    const row = await db.anicliDownload.findUnique({ where:{ id }});
    if(!row || row.accountId !== req.accountId) return reply.code(404).send({ error:"not found"});
    await anicliQueue.remove(anicliJobId(id)).catch(()=>{});
    if(row.status==="QUEUED" || row.status==="SEARCHING") await db.anicliDownload.update({ where:{ id }, data:{ status:"CANCELLED"}});
    else await db.anicliDownload.delete({ where:{ id }}).catch(()=>{});
    return { revoked:true };
  });
}
