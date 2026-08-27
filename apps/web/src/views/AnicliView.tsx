import { useEffect, useState } from "react";
export default function AnicliView(){
  const [q,setQ]=useState(""); const [lib,setLib]=useState(""); const [libs,setLibs]=useState<any[]>([]); const [rows,setRows]=useState<any[]>([]); const [msg,setMsg]=useState("");
  useEffect(()=>{ fetch("/api/libraries",{headers:{Authorization:`Bearer ${localStorage.getItem("token")||""}`}}).then(r=>r.json()).then(d=>setLibs((d.libraries||d).filter((x:any)=>x.contentProfile==="ANIME"))).catch(()=>{});
    refresh();
  },[]);
  const refresh=()=> fetch("/api/anicli/downloads",{headers:{Authorization:`Bearer ${localStorage.getItem("token")||""}`}}).then(r=>r.json()).then(setRows).catch(()=>{});
  const submit=async()=>{
    setMsg(""); const r=await fetch("/api/anicli/downloads",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${localStorage.getItem("token")||""}`},body:JSON.stringify({libraryId:lib,query:q})});
    const j=await r.json(); if(!r.ok) setMsg(j.error||"failed"); else { setMsg("queued"); refresh(); }
  };
  return <div style={{padding:24,maxWidth:720}}><h1>Download from Internet (ani-cli)</h1><p style={{opacity:.7}}>ANIME libraries only. Admin only. 2 GiB free-space gate, 20 GiB cap, 30m timeout, no retries.</p>
  <select value={lib} onChange={e=>setLib(e.target.value)}><option value="">select ANIME library</option>{libs.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>
  <input value={q} onChange={e=>setQ(e.target.value)} placeholder="title e.g. Frieren" style={{marginLeft:8, width:300}}/>
  <button onClick={submit} disabled={!q||!lib} style={{marginLeft:8}}>Download</button>
  {msg&&<p>{msg}</p>}
  <h3>Recent</h3><ul>{rows.map(r=><li key={r.id}>{r.query} — {r.status} {r.error?`(${r.error.slice(0,120)})`:""}</li>)}</ul></div>;
}
