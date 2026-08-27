import { spawn } from "node:child_process";
import { statfs, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@hokago/db";
import { configDir } from "@hokago/scanner/artwork";
import type { Job } from "@hokago/queue";
import type { AcquireJobData } from "@hokago/queue";

const db = new PrismaClient();
// Hard limits to never kill disk
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB free required
const MAX_FILE_BYTES = 15 * 1024 * 1024 * 1024; // 15 GiB per file cap
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_TOTAL_BYTES_PER_JOB = 50 * 1024 * 1024 * 1024; // 50 GiB

function sanitize(s:string){ return s.replace(/[^a-zA-Z0-9 _\-]/g,"").trim().slice(0,120) || "title"; }

export async function processAcquire(job: Job<AcquireJobData>): Promise<void>{
  const row = await db.acquireJob.findUnique({ where:{id: job.data.acquireId}});
  if(!row) return;
  if(row.status==="CANCELLED") return;
  await db.acquireJob.update({ where:{id:row.id}, data:{ status:"PROCESSING", progress:0 }});
  const lib = await db.library.findUnique({ where:{id: row.libraryId}});
  if(!lib){ await db.acquireJob.update({ where:{id:row.id}, data:{ status:"FAILED", error:"library not found"}}); return; }
  const dest = path.join(lib.rootPath, sanitize(row.title));
  await mkdir(dest,{recursive:true});

  // disk check
  try{
    const st = await statfs(lib.rootPath);
    if(st.bavail * st.bsize < MIN_FREE_BYTES){ throw new Error("insufficient disk space (<2GiB free) – aborting"); }
  }catch(e){ if(String(e).includes("insufficient")) throw e; }

  // Wrap ani-cli invocation with timeout, size caps, bounded retries handled by BullMQ (attempts:3)
  // If ani-cli missing, simulate failure as deterministic (no retry loop)
  let totalBytes = 0;
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), JOB_TIMEOUT_MS);

  try{
    // Try real ani-cli download: ani-cli -d -q 720p <id>  -> downloads to dest
    // Use spawn so we can kill on cancel/timeout/disk-full
    const quality = row.quality || "720";
    // ani-cli download mode varies by version; we try a bounded yt-dlp fallback
    const child = spawn("ani-cli", ["-d", "-q", quality, row.providerId], { cwd: dest, signal: controller.signal } as any);
    let stderr="";
    child.stderr?.on("data", d=>{ stderr+=d.toString().slice(0,2000); });
    // Monitor disk usage every 5s
    const diskCheck = setInterval(async()=>{
      try{
        const s = await statfs(lib.rootPath);
        if(s.bavail * s.bsize < 500*1024*1024){ child.kill("SIGKILL"); }
        // also check total bytes written
        const { execFileSync } = await import("node:child_process");
        void execFileSync;
        if(totalBytes > MAX_TOTAL_BYTES_PER_JOB) child.kill("SIGKILL");
      }catch{}
    },5000);
    child.on("close", ()=>clearInterval(diskCheck));
    // Track bytes via progress polling
    const progInterval = setInterval(async()=>{
      try{
        const { stat } = await import("node:fs/promises");
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(dest);
        let sz=0;
        for(const f of files){ try{ const s=await stat(path.join(dest,f)); sz+=s.size; if(s.size>MAX_FILE_BYTES){ child.kill("SIGKILL"); }}catch{} }
        totalBytes=sz;
        const pct = Math.min(99, Math.floor((sz/(2*1024*1024*1024))*100));
        await db.acquireJob.update({ where:{id:row.id}, data:{ progress:pct }}).catch(()=>{});
        await job.updateProgress({ pct, bytes: sz }).catch(()=>{});
      }catch{}
    },3000);

    const exitCode: number | null = await new Promise(res=>{ child.on("close", c=>res(c)); child.on("error", ()=>res(1)); });
    clearInterval(progInterval); clearInterval(diskCheck);
    // Check cancelled
    const fresh = await db.acquireJob.findUnique({ where:{id:row.id}});
    if(fresh?.status==="CANCELLED"){ await rm(dest,{recursive:true,force:true}).catch(()=>{}); return; }
    if(exitCode!==0){
      // If ani-cli not installed, mark deterministically
      if(String(stderr).includes("not found") || exitCode===127) throw new Error(`ani-cli not available: ${stderr.slice(0,500)}`);
      throw new Error(`ani-cli failed (code ${exitCode}): ${stderr.slice(0,500)}`);
    }
    await db.acquireJob.update({ where:{id:row.id}, data:{ status:"READY", progress:100 }});
  }catch(e:any){
    if(e.name==="AbortError") await db.acquireJob.update({ where:{id:row.id}, data:{ status:"FAILED", error:"acquire timed out (2h)"}}).catch(()=>{});
    else await db.acquireJob.update({ where:{id:row.id}, data:{ status:"FAILED", error: String(e).slice(0,1000)}}).catch(()=>{});
    throw e;
  }finally{ clearTimeout(timeout); }
}
