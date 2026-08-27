import { useEffect, useState } from "react";
export default function AnicliView(){
  const [q,setQ]=useState(""); const [lib,setLib]=useState(""); const [libs,setLibs]=useState<any[]>([]); const [rows,setRows]=useState<any[]>([]); const [msg,setMsg]=useState(""); const [searching,setSearching]=useState(false); const [results,setResults]=useState<string[]>([]);
  useEffect(()=>{ fetch("/api/libraries",{ headers:{ Authorization:`Bearer ${localStorage.getItem("hokago_access_token")||""}`}}).then(r=>r.json()).then(d=> setLibs(((d.libraries||d)||[]).filter((x:any)=>x.contentProfile==="ANIME"))).catch(()=>{}); refresh(); },[]);
  const refresh=()=> fetch("/api/anicli/downloads",{ headers:{ Authorization:`Bearer ${localStorage.getItem("hokago_access_token")||""}`}}).then(r=>r.json()).then(d=> setRows(d||[])).catch(()=>{});
  const search=async()=>{ setSearching(true); const r=await fetch("/api/anicli/search",{ method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${localStorage.getItem("hokago_access_token")||""}`}, body: JSON.stringify({ query:q })}).then(r=>r.json()).catch(()=>({})); setResults(r.results||[]); if(r.error) setMsg(r.error); setSearching(false); };
  const submit=async()=>{ setMsg(""); const r=await fetch("/api/anicli/downloads",{ method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${localStorage.getItem("hokago_access_token")||""}`}, body: JSON.stringify({ libraryId:lib, query:q })}).then(r=>r.json()); if(r.error) setMsg(r.error); else { setMsg("queued"); refresh(); } };
  return <div className="mx-auto max-w-[900px] px-6 pb-24 pt-28">
    <h1 className="font-display text-title font-bold">Acquire from Internet</h1>
    <p className="text-meta text-ink-2">ANIME libraries only · Admin only · 60GB hard cap · 2 GiB free gate</p>
    <div className="panel mt-6 flex flex-wrap gap-3 rounded-[22px] p-5">
      <select className="input" value={lib} onChange={e=>setLib(e.target.value)}><option value="">select ANIME library</option>{libs.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>
      <input className="input flex-1" value={q} onChange={e=>setQ(e.target.value)} placeholder="title e.g. Frieren S2"/>
      <button className="btn btn-ghost" onClick={search} disabled={!q||searching}>{searching?"searching…":"Search"}</button>
      <button className="btn btn-primary" onClick={submit} disabled={!q||!lib}>Download</button>
    </div>
    {results.length>0 && <ul className="panel mt-4 p-4">{results.map(r=><li key={r} className="text-small"><button className="text-wii-deep" onClick={()=>setQ(r)}>{r}</button></li>)}</ul>}
    {msg&&<p className="mt-3 text-small text-accent">{msg}</p>}
    <h3 className="mt-6 font-bold">Recent</h3><ul className="flex flex-col gap-2 mt-2">{rows.map(r=><li key={r.id} className="panel px-4 py-3 text-small">{r.query} — {r.status} {r.progress?`(${JSON.stringify(r.progress)})`:""} {r.error?`(${String(r.error).slice(0,120)})`:""}</li>)}</ul>
  </div>;
}
