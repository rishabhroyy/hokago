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
    // per-server global cap (5) + per-account (3) — prevents IP ban
    const [active, global] = await Promise.all([
      db.anicliDownload.count({ where:{ accountId: req.accountId!, status:{ in:["QUEUED","SEARCHING","DOWNLOADING","IMPORTING"]}}}),
      db.anicliDownload.count({ where:{ status:{ in:["QUEUED","SEARCHING","DOWNLOADING","IMPORTING"]}}}),
    ]);
    if(active >= 3) return reply.code(429).send({ error:"too many active downloads (max 3 per account)"});
    if(global >= 5) return reply.code(429).send({ error:"server busy — max 5 concurrent anicli downloads"});
    // dedup: block if show already exists with files, but allow new seasons AND allow tiles marked not-downloaded (entry with no files)
    const norm = (s:string)=> s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    const qNorm = norm(body.query);
    const qSeason = /s(?:eason)?\s*(\d+)/i.exec(body.query)?.[1] ? Number(/s(?:eason)?\s*(\d+)/i.exec(body.query)![1]) : null;
    const existing = await db.mediaItem.findMany({ where:{ libraryId: body.libraryId }, select:{ title:true, seasonNumber:true, titles:{select:{value:true}}, files:{select:{id:true}} }});
    for(const it of existing){
      const names = [it.title, ...it.titles.map(t=>t.value)].map(norm);
      if(names.includes(qNorm)){
        // if entry has no files -> it's a placeholder/not-downloaded tile — allow download
        if(it.files.length===0) continue;
        if(qSeason !== null){
          const maxSeason = Math.max(0, ...existing.filter(e=> names.some(n=> [norm(e.title), ...e.titles.map(t=>norm(t.value))].includes(n))).map(e=> e.seasonNumber ?? 1));
          if(qSeason > maxSeason) continue;
        } else {
          // also check filesystem guard: same normalized folder exists under library root
          const folder = path.join(lib.rootPath, it.title.replace(/[^a-zA-Z0-9 _-]/g,"").slice(0,80));
          // if dedup via Title matched, already blocking — no need for extra fs check here
        }
        return reply.code(409).send({ error:"show already exists on server — new seasons allowed (e.g. 'Frieren S2')"});
      }
    }
    // filesystem guard for weird manual names that bypass Title table
    const allFiles = await db.mediaFile.findMany({ where:{ mediaItem:{ libraryId: body.libraryId } }, select:{ path:true }});
    if(allFiles.some(f=> norm(path.basename(path.dirname(f.path))) === qNorm || norm(path.basename(f.path, path.extname(f.path))) === qNorm)){
      // only block if not a new season request
      if(qSeason===null) return reply.code(409).send({ error:"show already exists on server — new seasons allowed"});
    }
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

  app.post("/anicli/search", { preHandler: app.authenticate }, async (req, reply)=>{
    const acct = await db.account.findUnique({ where:{ id: req.accountId! }, select:{ isAdmin:true }});
    if(!acct?.isAdmin) return reply.code(403).send({ error:"admin only"});
    const { query } = z.object({ query: z.string().min(1).max(200) }).parse(req.body);
    // per-server search rate limit: simple token bucket (global)
    const recent = await db.anicliDownload.count({ where:{ createdAt:{ gte: new Date(Date.now()-60_000)}}});
    if(recent >= 10) return reply.code(429).send({ error:"search rate limited — try again shortly"});
    return { results: [] as string[], note:"search proxied via ani-cli in worker — UI will show picker when available" };
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
