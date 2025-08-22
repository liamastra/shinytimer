import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/* -------------------------------------------------
   Supabase client (works in Canvas and locally)
   If env vars are missing (Canvas), supabase = null → local-only
----------------------------------------------------*/
const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL;
const supabaseAnon = import.meta.env?.VITE_SUPABASE_ANON;
const supabase = (supabaseUrl && supabaseAnon) ? createClient(supabaseUrl, supabaseAnon) : null;

/* ---------------- Helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pad = (n) => String(n).padStart(2, "0");
const fmtHMS = (sec) => { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = sec%60; return `${pad(h)}:${pad(m)}:${pad(s)}` };

/* ---------------- Themes (glass pastel + transparent) ---------------- */
const THEME_SWATCHES = [
  { id: "cb", label: "Cyan→Blue",       val: "from-cyan-500/30 to-blue-500/30" },
  { id: "et", label: "Emerald→Teal",    val: "from-emerald-500/30 to-teal-500/30" },
  { id: "vf", label: "Violet→Fuchsia",  val: "from-violet-500/30 to-fuchsia-500/30" },
  { id: "ao", label: "Amber→Orange",    val: "from-amber-500/30 to-orange-500/30" },
  { id: "lg", label: "Lime→Green",      val: "from-lime-500/30 to-green-500/30" },
  { id: "si", label: "Sky→Indigo",      val: "from-sky-500/30 to-indigo-500/30" },
  { id: "rr", label: "Rose→Red",        val: "from-rose-500/30 to-red-500/30" },
  { id: "tr", label: "Transparent",     val: "from-white/0 to-white/0" },
];

/* ---------------- Defaults ---------------- */
const DEFAULT_TIMERS = [
  { id: uid(), name: "Working Hour", targetSec: 11*3600, revisionSec: 0, running:false, startTs:null, elapsedSec:0, goalOn:true, goalFired:false, category:"work", color: THEME_SWATCHES[0].val, sort_index:0, deleted:false },
];

/* ---------------- Root App ---------------- */
export default function App() {
  // profile + timers (local first)
  const [profile, setProfile] = useState(() => {
    const saved = localStorage.getItem("tt_profile");
    return saved ? JSON.parse(saved) : { name: "Your Name", photo: null, emoji: "🌟" };
  });
  const [timers, setTimers] = useState(() => {
    const saved = localStorage.getItem("tt_timers");
    const arr = saved ? JSON.parse(saved) : DEFAULT_TIMERS;
    return arr.map((t, i) => ({ goalFired:false, revisionSec: t.revisionSec ?? 0, sort_index: t.sort_index ?? i, deleted: !!t.deleted, ...t }));
  });

  // ui
  const [dragId, setDragId] = useState(null);
  const [editTimer, setEditTimer] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [celebration, setCelebration] = useState({ active: false, message: "" });

  // auth
  const [user, setUser] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const saveDebounce = useRef(null);

  // confetti
  const confettiLayer = useRef(null);
  const confettiIntervalRef = useRef(null);

  /* ---------- Persist locally ---------- */
  useEffect(() => { localStorage.setItem("tt_timers", JSON.stringify(timers)); }, [timers]);
  useEffect(() => { localStorage.setItem("tt_profile", JSON.stringify(profile)); }, [profile]);

  /* ---------- Auth session ---------- */
  useEffect(() => {
    if (!supabase) return;
    let ignore = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!ignore) setUser(data.session?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => { setUser(session?.user ?? null); });
    return () => { ignore = true; sub?.subscription?.unsubscribe?.(); };
  }, []);

  /* ---------- Load from cloud on sign-in ---------- */
  useEffect(() => {
    if (!supabase || !user) return;
    (async () => {
      const { data: rows, error } = await supabase
        .from("timers").select("*")
        .eq("user_id", user.id)
        .eq("deleted", false) // <— important: filter out soft-deleted
        .order("sort_index", { ascending: true });
      if (!error) {
        if (!rows || rows.length === 0 && timers.length>0) {
          await upsertAllToCloud(user.id, timers);
        } else if (rows) {
          const mapped = rows.map(r => ({
            id:r.id, name:r.name, targetSec:r.target_sec, revisionSec:r.revision_sec,
            elapsedSec:r.elapsed_sec, startTs:r.start_ts??null, running:r.running,
            goalOn:r.goal_on, goalFired:r.goal_fired, category:r.category, color:r.color,
            sort_index:r.sort_index ?? 0, deleted: !!r.deleted
          }));
          mapped.sort((a,b)=>(a.sort_index??0)-(b.sort_index??0));
          setTimers(mapped);
        }
      }
      const { data: prof } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
      if (prof) setProfile({ name: prof.name ?? "Your Name", emoji: prof.emoji ?? "🌟", photo: prof.photo ?? null });
      else await supabase.from("profiles").insert({ user_id:user.id, name: profile.name, emoji: profile.emoji, photo: profile.photo });
    })();
  }, [user]);

  // Real-time subscribe to your own timers (includes DELETE and soft-delete)
  useEffect(() => {
    if (!supabase || !user) return;

    const channel = supabase
      .channel('timers-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'timers', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const id = payload.old?.id; if (!id) return;
            setTimers(prev => prev.filter(t => t.id !== id));
            return;
          }
          const row = payload.new || payload.old; if (!row) return;
          if (row.deleted) { setTimers(prev => prev.filter(t => t.id !== row.id)); return; }
          setTimers((prev) => {
            const i = prev.findIndex(t => t.id === row.id);
            const next = [...prev];
            const mapped = {
              id: row.id, name: row.name, category: row.category,
              targetSec: row.target_sec, revisionSec: row.revision_sec,
              elapsedSec: row.elapsed_sec, startTs: row.start_ts ?? null,
              running: row.running, goalOn: row.goal_on, goalFired: row.goal_fired,
              color: row.color, sort_index: row.sort_index ?? 0, deleted: !!row.deleted,
            };
            if (i === -1) next.push(mapped); else next[i] = mapped;
            next.sort((a,b)=>(a.sort_index??0)-(b.sort_index??0));
            return next;
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);


  /* ---------- Save to cloud on timers/profile change (debounced) ---------- */
  useEffect(() => {
    if (!supabase || !user) return;
    if (saveDebounce.current) clearTimeout(saveDebounce.current);
    saveDebounce.current = setTimeout(() => { upsertAllToCloud(user.id, timers); }, 400);
    return () => clearTimeout(saveDebounce.current);
  }, [timers, user]);
  useEffect(() => {
    if (!supabase || !user) return;
    (async () => {
      await supabase.from("profiles").upsert({ user_id:user.id, name: profile.name, emoji: profile.emoji, photo: profile.photo, updated_at:new Date().toISOString() });
    })();
  }, [profile, user]);

  async function upsertAllToCloud(userId, list) {
    if (!supabase) return;
    const rows = list.map((t, idx) => ({ id:t.id, user_id:userId, name:t.name, target_sec:Math.floor(t.targetSec||0), revision_sec:Math.floor(t.revisionSec||0), elapsed_sec:Math.floor(t.elapsedSec||0), start_ts:t.startTs?Math.floor(t.startTs):null, running:!!t.running, goal_on:!!t.goalOn, goal_fired:!!t.goalFired, category:t.category, color:t.color, sort_index: idx, deleted: !!t.deleted, updated_at:new Date().toISOString() }));
    const { error } = await supabase.from("timers").upsert(rows, { onConflict:"id" }); if (error) console.error(error);
  }

  /* ---------- Timer math & logic ---------- */
  function timerNetSeconds(t) {
    const runningNow = t.running && t.startTs ? (Date.now() - t.startTs) / 1000 : 0;
    return Math.max(0, (t.elapsedSec + runningNow) - (t.revisionSec || 0));
  }

  // goal checker
  useEffect(() => {
    const id = setInterval(() => {
      setTimers(prev => prev.map(t => {
        const net = timerNetSeconds(t);
        if (t.goalOn && !t.goalFired && t.targetSec > 0 && net >= t.targetSec) {
          startCelebration(`Congratulations! You reached your goal of ${fmtHMS(t.targetSec)} for "${t.name}"`);
          return { ...t, goalFired: true };
        }
        return t;
      }));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  function startTimer(id) {
    setTimers(prev => prev.map(t => {
      if (t.id === id) {
        if (t.running) return t;
        return { ...t, running: true, startTs: Date.now() };
      }
      if (t.running) {
        const add = t.startTs ? (Date.now() - t.startTs) / 1000 : 0;
        return { ...t, running: false, startTs: null, elapsedSec: Math.max(0, t.elapsedSec + add) };
      }
      return t;
    }));
  }
  function pauseTimer(id) {
    setTimers(prev => prev.map(t => {
      if (t.id !== id) return t;
      if (!t.running) return t;
      const add = t.startTs ? (Date.now() - t.startTs) / 1000 : 0;
      return { ...t, running: false, startTs: null, elapsedSec: Math.max(0, t.elapsedSec + add) };
    }));
  }
  function resetTimer(id) {
    setTimers(prev => prev.map(t => t.id === id ? { ...t, running:false, startTs:null, elapsedSec:0, revisionSec:0, goalFired:false } : t));
  }
  function resetAll() {
    setTimers(prev => prev.map(t => ({ ...t, running:false, startTs:null, elapsedSec:0, revisionSec:0, goalFired:false })));
  }

  // precise Add/Subtract (works while running or paused) — main UI only
  function adjustTimer(id, deltaSeconds) {
    setTimers(prev => prev.map(t => {
      if (t.id !== id) return t;
      if (t.running) {
        const add = t.startTs ? (Date.now() - t.startTs) / 1000 : 0; // capture run so far
        const newElapsed = Math.max(0, t.elapsedSec + add + deltaSeconds);
        return { ...t, elapsedSec: newElapsed, startTs: Date.now() };
      } else {
        const newElapsed = Math.max(0, t.elapsedSec + deltaSeconds);
        return { ...t, elapsedSec: newElapsed };
      }
    }));
  }

  function applyPatch(id, patch) {
    setTimers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }

  function addTimer() {
    const t = { id: uid(), name: "New Timer", targetSec:0, revisionSec:0, running:false, startTs:null, elapsedSec:0, goalOn:false, goalFired:false, category:"neutral", color: THEME_SWATCHES[2].val, sort_index: timers.length, deleted:false };
    setTimers(prev => [t, ...prev]);
    setEditTimer(t);
  }
  async function removeTimer(id) {
    // local remove (instant)
    setTimers(prev => prev.filter(t => t.id !== id));
    setEditTimer(null);
    if (supabase && user) {
      // Try hard delete first (should pass your policy). If it fails, soft-delete.
      const del = await supabase.from('timers').delete().eq('user_id', user.id).eq('id', id);
      if (del.error) {
        await supabase.from('timers').update({ deleted:true, updated_at: new Date().toISOString() }).eq('user_id', user.id).eq('id', id);
      }
    }
  }

  // drag & drop reordering (persist sort_index via debounced upsert)
  function onDragStart(e, id) { setDragId(id); e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; }
  function onDragOverItem(e, overId) {
    e.preventDefault(); const dragging = dragId; if (!dragging || dragging === overId) return;
    setTimers(prev => { const arr=[...prev]; const from=arr.findIndex(x=>x.id===dragging); const to=arr.findIndex(x=>x.id===overId); if(from<0||to<0) return prev; const [m]=arr.splice(from,1); arr.splice(to,0,m); return arr.map((t,idx)=>({ ...t, sort_index: idx })); });
  }
  function onDropList(e) { e.preventDefault(); setDragId(null); }

  // celebration overlay (persists until click)
  function startCelebration(message) { setCelebration({ active:true, message }); startConfettiContinuous(); }
  function stopCelebration() { setCelebration({ active:false, message:"" }); stopConfetti(); }
  function startConfettiContinuous() {
    const layer = confettiLayer.current; if (!layer) return; if (confettiIntervalRef.current) clearInterval(confettiIntervalRef.current);
    confettiIntervalRef.current = setInterval(() => { spawnConfettiBurst(layer, 24); }, 140);
  }
  function stopConfetti() { if (confettiIntervalRef.current) { clearInterval(confettiIntervalRef.current); confettiIntervalRef.current = null; } const layer=confettiLayer.current; if(layer) layer.querySelectorAll('.confetti-piece').forEach(n=>n.remove()); }
  function spawnConfettiBurst(layer, count=140) {
    for (let i=0;i<count;i++) { const piece=document.createElement("span"); piece.className="confetti-piece"; const size=Math.random()*8+6; const startLeft=Math.random()*100; const rotate=Math.random()*360; const duration=2200+Math.random()*2400; piece.style.setProperty("--size",`${size}px`); piece.style.setProperty("--left",`${startLeft}vw`); piece.style.setProperty("--rotate",`${rotate}deg`); piece.style.setProperty("--duration",`${duration}ms`); layer.appendChild(piece); setTimeout(()=>piece.remove(), duration+200); }
  }

  const totalTracked = useMemo(() => timers.reduce((a, t) => a + timerNetSeconds(t), 0), [timers]);

  /* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen w-full overflow-x-hidden relative">
      {/* Background (removed moving shimmer line per your request) */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.08),transparent_40%),radial-gradient(circle_at_80%_0%,rgba(255,255,255,0.06),transparent_35%),radial-gradient(circle_at_10%_90%,rgba(255,255,255,0.05),transparent_35%)]" />
      </div>

      {/* Confetti Layer */}
      <div ref={confettiLayer} className="pointer-events-none fixed inset-0 z-40 overflow-hidden" />

      {/* Celebration Overlay */}
      {celebration.active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={stopCelebration}>
          <div className="text-center px-6">
            <div className="text-3xl md:text-5xl font-extrabold glow-text bg-clip-text text-transparent bg-[linear-gradient(90deg,#a7f3d0,#60a5fa,#f472b6,#fde68a,#a7f3d0)] bg-[length:200%_100%]">
              {celebration.message}
            </div>
            <div className="mt-3 text-white/80">Click anywhere to dismiss</div>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <header className="sticky top-0 z-30 backdrop-blur bg-slate-900/60 border-b border-white/10">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between">
          {/* Combined: Profile / Sign in */}
          <button onClick={() => { user ? setProfileOpen(true) : setAuthOpen(true); }} className="flex items-center gap-3 group">
            <div className="relative">
              {profile.photo ? (
                <img src={profile.photo} alt="avatar" className="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-cyan-500/20" />
              ) : (
                <div className="w-10 h-10 rounded-2xl bg-white/10 border border-white/15 grid place-items-center text-xl">
                  <span className="select-none">{profile.emoji || "🌟"}</span>
                </div>
              )}
              <div className="absolute -right-1 -bottom-1 w-5 h-5 rounded-full bg-white/15 border border-white/20 flex items-center justify-center text-xs">✏️</div>
            </div>
            <div className="text-left">
              <div className="text-white font-bold text-lg leading-5">{user ? (profile.name || "Your Name") : "Sign in"}</div>
              <div className="text-white/70 text-[11px]">{user ? (user.email) : 'Time Tracker'}</div>
            </div>
          </button>

          <div className="flex items-center gap-2">
            <button onClick={addTimer} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 text-white font-semibold shadow-lg hover:scale-[1.02] active:scale-[0.98] transition">+ Add Timer</button>
            <button onClick={resetAll} className="px-3 py-2 rounded-xl bg-white/10 text-white/90 border border-white/10 hover:bg-white/15">Reset Day</button>
            <button onClick={()=>exportCSV(timers)} className="px-3 py-2 rounded-xl bg-white/10 text-white/90 border border-white/10 hover:bg-white/15">Export CSV</button>
            <div className="text-slate-300 text-sm hidden md:block">
              Total tracked: <span className="time-mono text-white font-semibold">{fmtHMS(totalTracked)}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Timers List */}
      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="space-y-4" onDragOver={(e) => e.preventDefault()} onDrop={onDropList}>
          {timers.map((t) => (
            <TimerCard
              key={t.id}
              t={t}
              onDragStart={onDragStart}
              onDragOverItem={onDragOverItem}
              onClick={() => setEditTimer(t)}
              start={() => startTimer(t.id)}
              pause={() => pauseTimer(t.id)}
              reset={() => resetTimer(t.id)}
              netSeconds={timerNetSeconds(t)}
              adjust={(d)=>adjustTimer(t.id, d)}
            />
          ))}
          {timers.length === 0 && (
            <div className="text-center text-white/60 py-16 border border-white/10 rounded-3xl bg-white/5">
              No timers. Click “+ Add Timer”.
            </div>
          )}
        </div>
      </main>

      {/* Modals */}
      {editTimer && (
        <Modal onClose={() => setEditTimer(null)}>
          <TimerEditor
            timer={editTimer}
            onSave={(patch) => { applyPatch(editTimer.id, patch); setEditTimer(null); }}
            onDelete={() => removeTimer(editTimer.id)}
          />
        </Modal>
      )}

      {profileOpen && (
        <Modal onClose={() => setProfileOpen(false)}>
          <ProfileEditor profile={profile} user={user} onSave={(p) => { setProfile(p); setProfileOpen(false); }} />
        </Modal>
      )}

      {/* Auth panel */}
      {authOpen && !user && <AuthPanel onClose={() => setAuthOpen(false)} />}

      <StyleTags />
      <ClassKeepAlive />
    </div>
  );
}

/* ---------------- Card & UI components ---------------- */
function TimerCard({ t, onDragStart, onDragOverItem, onClick, start, pause, reset, netSeconds, adjust }) {
  const [xy, setXy] = useState({ x: 50, y: 50 });
  const running = t.running;
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, t.id)}
      onDragOver={(e) => onDragOverItem(e, t.id)}
      onClick={onClick}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        setXy({ x, y });
      }}
      className={`group relative cursor-grab active:cursor-grabbing rounded-3xl border border-white/10 backdrop-blur p-4 shadow-lg transition hover:scale-[1.01] bg-gradient-to-br ${t.color}`}
    >
      {/* radial hover glow on its own layer so it DOES NOT override the theme gradient */}
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ background: `radial-gradient(600px circle at ${xy.x}% ${xy.y}%, rgba(255,255,255,0.10), transparent 40%)` }}
      />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-white/15 border border-white/20 grid place-items-center text-white/90 text-lg">⏱️</div>
          <div>
            <div className="text-white font-semibold text-lg leading-tight drop-shadow-sm">{t.name}</div>
            <div className="text-white/80 text-sm">Target: {t.targetSec > 0 ? fmtHMS(t.targetSec) : "–"} {t.goalOn ? "• Goal ON" : "• Goal OFF"}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="time-mono text-white text-2xl drop-shadow-sm min-w-[130px] text-right">{fmtHMS(netSeconds)}</div>
          <button
            onClick={(e) => { e.stopPropagation(); running ? pause() : start(); }}
            className={`w-11 h-11 rounded-full grid place-items-center text-xl text-white shadow-lg transition ${running ? "bg-gradient-to-tr from-rose-500 to-red-500" : "bg-gradient-to-tr from-lime-500 to-green-600"}`}
            aria-label={running ? "Pause" : "Start"}
          >
            {running ? "❚❚" : "►"}
          </button>
          <button onClick={(e) => { e.stopPropagation(); reset(); }} className="px-3 py-2 rounded-xl bg-white/10 text-white/90 hover:bg-white/20 border border-white/10">Reset</button>
          {/* Edit button removed — entire card opens the editor */}
        </div>
      </div>

      {/* Quick adjust row */}
      <QuickAdjust onAdd={(s)=>adjust(+s)} onSub={(s)=>adjust(-s)} />

      {/* Shine overlay */}
      <div className="pointer-events-none absolute inset-0 rounded-3xl overflow-hidden">
        <div className="absolute -inset-[40%] rotate-12 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-120%] group-hover:animate-card-shine" />
      </div>
    </div>
  );
}

function QuickAdjust({ onAdd, onSub }) {
  const [h, setH] = useState(0); const [m, setM] = useState(0);
  function toSec(){ return Math.max(0, (parseInt(h)||0)*3600 + (parseInt(m)||0)*60); }
  function add(){ const s=toSec(); if(s>0){ onAdd(s); setH(0); setM(0); } }
  function sub(){ const s=toSec(); if(s>0){ onSub(s); setH(0); setM(0); } }
  return (
    <div className="mt-3 flex items-center gap-2 text-sm"
         onMouseDown={(e)=>e.stopPropagation()}
         onClick={(e)=>e.stopPropagation()}
         onTouchStart={(e)=>e.stopPropagation()}
         onPointerDown={(e)=>e.stopPropagation()}>
      <span className="text-white/70">Adjust:</span>
      <input type="number" min="0" value={h} onChange={(e)=>setH(e.target.value)} className="w-20 rounded-xl bg-white/10 border border-white/15 px-2 py-1" />
      <span>:</span>
      <input type="number" min="0" max="59" value={m} onChange={(e)=>setM(clamp(Number(e.target.value),0,59))} className="w-20 rounded-xl bg-white/10 border border-white/15 px-2 py-1" />
      <button onClick={(e)=>{ e.stopPropagation(); add(); }} className="px-2 py-1 rounded-lg bg-gradient-to-tr from-lime-500 to-green-600 active:scale-95">Add</button>
      <button onClick={(e)=>{ e.stopPropagation(); sub(); }} className="px-2 py-1 rounded-lg bg-gradient-to-tr from-rose-500 to-red-600 active:scale-95">Subtract</button>
    </div>
  );
}

function Modal({ children, onClose }) {
  useEffect(() => { function onKey(e){ if(e.key==="Escape") onClose(); } window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[min(720px,95vw)] max-h-[90vh] overflow-y-auto rounded-3xl border border-white/10 bg-slate-900/85 p-6 text-white shadow-2xl">
        <button onClick={onClose} className="sticky float-right right-0 top-0 rounded-full bg-white/10 hover:bg-white/20 w-8 h-8 grid place-items-center" aria-label="Close">✕</button>
        {children}
      </div>
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-xl bg-white/10 p-1 border border-white/10">
      {options.map((opt) => (
        <button key={opt.value} type="button" onClick={() => onChange(opt.value)} className={`px-3 py-1.5 rounded-lg text-sm transition ${value === opt.value ? "bg-white/30 text-white" : "text-white/80 hover:bg:white/20"}`}>{opt.label}</button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="relative inline-flex items-center gap-2 select-none" aria-pressed={checked}>
      <span className="text-sm text-white/80">{label}</span>
      <span className={`w-12 h-7 rounded-full p-1 transition bg-white/10 border border-white/10 ${checked ? "ring-2 ring-green-400/60" : ""}`}>
        <span className={`block w-5 h-5 rounded-full bg-gradient-to-tr ${checked ? "from-lime-400 to-green-500 translate-x-5" : "from-slate-300 to-slate-100 translate-x-0"} shadow-md transition`} />
      </span>
    </button>
  );
}

function ThemeSwatches({ value, onChange }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {THEME_SWATCHES.map(s => (
        <button key={s.id} type="button" onClick={() => onChange(s.val)} className={`h-10 rounded-xl border ${value===s.val?"border-white/80":"border-white/10"} bg-gradient-to-r ${s.val} relative overflow-hidden`}>
          <span className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.15),transparent)] translate-x-[-120%] hover:animate-card-shine" />
        </button>
      ))}
    </div>
  );
}

function TimerEditor({ timer, onSave, onDelete }) {
  const [form, setForm] = useState({ ...timer });
  const [targetH, setTargetH] = useState(Math.floor((form.targetSec || 0) / 3600));
  const [targetM, setTargetM] = useState(Math.floor(((form.targetSec || 0) % 3600) / 60));

  function patch(name, value) { setForm(f => ({ ...f, [name]: value })); }
  function save() { const tSec = clamp(Number(targetH)*3600 + Number(targetM)*60, 0, 999*3600); onSave({ ...form, targetSec: tSec }); }

  return (
    <div className="space-y-5">
      <h3 className="text-xl font-bold">Edit Time Info</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Name">
          <input value={form.name} onChange={(e) => patch("name", e.target.value)} className="w-full rounded-xl bg:white/5 border border-white/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-white placeholder-white/50" />
        </Field>
        <Field label="Category">
          <Segmented value={form.category} onChange={(v) => patch("category", v)} options={[{label:"Work", value:"work"},{label:"Break", value:"break"},{label:"Neutral", value:"neutral"}]} />
        </Field>

        <Field label="Target Time (H : M)">
          <div className="flex items-center gap-2">
            <input type="number" min="0" value={targetH} onChange={(e) => setTargetH(e.target.value)} className="w-20 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-white" />
            <span>:</span>
            <input type="number" min="0" max="59" value={targetM} onChange={(e) => setTargetM(clamp(Number(e.target.value),0,59))} className="w-20 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-white" />
          </div>
        </Field>

        <Field label="Goal Celebration">
          <Switch checked={!!form.goalOn} onChange={(v) => patch("goalOn", v)} label="Celebrate when reaching target" />
        </Field>

        <Field label="Theme">
          <ThemeSwatches value={form.color} onChange={(v) => patch("color", v)} />
          <div className={`mt-2 h-3 rounded-full bg-gradient-to-r ${form.color}`} />
        </Field>
      </div>

      <div className="flex justify-between gap-2">
        <button onClick={save} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 font-semibold active:scale-95">Save & Close</button>
        <button onClick={onDelete} className="px-3 py-2 rounded-xl bg-white/10 border border-rose-400/30 text-rose-200">Delete</button>
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onSave, user }) {
  const EMOJIS = ["😺","🐻","🐼","🦊","🐯","🐵","🐨","🐸","🐰","🐥","🌟","🚀","🎨","🎧","🧠","🐳","🍀","🔥","💎","🍉","🍩"];
  const [name, setName] = useState(profile.name || "");
  const [emoji, setEmoji] = useState(profile.emoji || "🌟");
  const [photo, setPhoto] = useState(profile.photo || null);

  function onFile(e) { const f = e.target.files?.[0]; if (!f) return; const reader = new FileReader(); reader.onload = () => { setPhoto(reader.result); }; reader.readAsDataURL(f); }

  async function signOut(){ if(supabase) await supabase.auth.signOut(); }

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold">{user? `Signed in as ${user.email}` : 'Profile'}</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div className="md:col-span-1">
          <div className="w-16 h-16 rounded-2xl bg-white/10 border border-white/15 grid place-items-center text-2xl mb-2">
            {photo ? <img src={photo} alt="avatar" className="w-16 h-16 rounded-2xl object-cover" /> : <span>{emoji}</span>}
          </div>
          <div className="text-xs text-white/70">Current avatar</div>
        </div>
        <div className="md:col-span-2 space-y-3">
          <Field label="Name">
            <input value={name} onChange={(e)=>setName(e.target.value)} placeholder="Your Name" className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-white" />
          </Field>
          <Field label="Choose an Emoji Avatar (no storage)">
            <div className="grid grid-cols-8 gap-2">
              {EMOJIS.map(ej => (
                <button key={ej} type="button" onClick={()=>{ setEmoji(ej); setPhoto(null); }} className={`h-10 rounded-xl border grid place-items-center text-lg ${emoji===ej?"border-white/80 bg-white/10":"border-white/10 bg-white/5 hover:bg-white/10"}`}>{ej}</button>
              ))}
            </div>
          </Field>
          <details className="text-sm text-white/70">
            <summary className="cursor-pointer mb-2">Or upload an image file</summary>
            <input type="file" accept="image/*" onChange={onFile} className="text-sm" />
          </details>
        </div>
      </div>
      <div className="flex justify-between gap-2">
        <button onClick={()=>onSave({ name, emoji, photo })} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 font-semibold active:scale-95">Save</button>
        {user && <button onClick={signOut} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-rose-500 to-red-600 active:scale-95">Sign out</button>}
      </div>
    </div>
  );
}

function Field({ label, children }) { return (<label className="text-sm text-white/80 space-y-1 block"><div className="ml-1 mb-0.5">{label}</div>{children}</label>); }

/* ---------------- Auth Panel (magic link) ---------------- */
function AuthPanel({ onClose }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);

  async function sendLink() {
    if (!supabase) { alert("Supabase env vars missing."); return; }
    setErr(""); setSending(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    setSending(false);
    if (error) setErr(error.message); else setSent(true);
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900/90 p-5 text-white">
          <button className="absolute right-3 top-3" onClick={onClose}>✕</button>
          <div className="space-y-3">
            <div className="text-lg font-semibold">Sign in</div>
            <input placeholder="you@example.com" value={email} onChange={(e)=>setEmail(e.target.value)} className="w-full rounded-xl bg-white/10 border border-white/15 px-3 py-2" />
            <button onClick={sendLink} disabled={!email || sending} className="w-full px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 active:scale-95 disabled:opacity-60">{sending?"Sending...": sent?"Link sent ✓":"Send magic link"}</button>
            {sent && <div className="text-emerald-300 text-sm">Check your email and click the link.</div>}
            {err && <div className="text-rose-300 text-sm">{err}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Export CSV ---------------- */
function exportCSV(timers){
  const rows = [["id","name","category","targetSec","elapsedSec","revisionSec","running","startTs","goalOn","goalFired","color","netSec","human"]];
  const data = timers.map(t=>{ const runningNow = t.running && t.startTs ? (Date.now()-t.startTs)/1000 : 0; const net = Math.max(0,(t.elapsedSec + runningNow) - (t.revisionSec||0)); return [t.id,t.name,t.category,t.targetSec,Math.floor(t.elapsedSec),Math.floor(t.revisionSec||0),t.running?1:0,t.startTs||"",t.goalOn?1:0,t.goalFired?1:0,t.color,Math.floor(net),fmtHMS(net)]; });
  const csv = rows.concat(data).map(r=>r.map(x=>`"${String(x).replaceAll('"','""')}"`).join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`shiny-timer-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------------- Global styles ---------------- */
function StyleTags() {
  return (
    <style>{`
      html,body,#root{height:100%}
      body{background:#0b1220}
      @keyframes cardShine { 0%{ transform: translateX(-120%) rotate(12deg);} 100%{ transform: translateX(120%) rotate(12deg);} }
      .animate-card-shine { animation: cardShine 1.1s ease forwards; }
      .time-mono { font-family: "Monomakh", sans-serif; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 2rem; }

      /* Confetti */
      .confetti-piece { position: fixed; top: -10vh; left: var(--left); width: var(--size); height: var(--size); background: hsl(var(--h,0),95%,60%); transform: rotate(var(--rotate)); animation: confettiFall var(--duration) ease-out forwards, confettiSpin calc(var(--duration)*0.8) linear infinite; z-index: 9999; border-radius: 2px; box-shadow: 0 0 0 1px rgba(255,255,255,0.15) inset; }
      .confetti-piece:nth-child(5n) { --h: 190 } .confetti-piece:nth-child(5n+1) { --h: 140 } .confetti-piece:nth-child(5n+2) { --h: 40 } .confetti-piece:nth-child(5n+3) { --h: 320 } .confetti-piece:nth-child(5n+4) { --h: 260 }
      @keyframes confettiFall { 0%{ transform: translateY(-10vh) rotate(var(--rotate)); opacity:1 } 100%{ transform: translateY(110vh) rotate(calc(var(--rotate) + 360deg)); opacity:.9 } }
      @keyframes confettiSpin { from { filter: brightness(1) } to { filter: brightness(1.2) } }
      .glow-text { filter: drop-shadow(0 0 14px rgba(255,255,255,0.25)) drop-shadow(0 0 34px rgba(255,255,255,0.15)); }
    `}</style>
  );
}

/* ---------------- Keep dynamic gradient classes (Tailwind v4) ---------------- */
function ClassKeepAlive() {
  return (
    <div className="
      hidden
      bg-gradient-to-r bg-gradient-to-br bg-gradient-to-tr
      from-cyan-500/30 to-blue-500/30
      from-emerald-500/30 to-teal-500/30
      from-violet-500/30 to-fuchsia-500/30
      from-amber-500/30 to-orange-500/30
      from-lime-500/30 to-green-500/30
      from-sky-500/30 to-indigo-500/30
      from-rose-500/30 to-red-500/30
      from-cyan-500 to-blue-500
      from-lime-500 to-green-600
      from-rose-500 to-red-600
      from-lime-400 to-green-500
      from-slate-300 to-slate-100
      ring-green-400/60
    " />
  );
}
