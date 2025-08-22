import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase ----------------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON;
const supabase = (supabaseUrl && supabaseAnon)
  ? createClient(supabaseUrl, supabaseAnon)
  : null;

// ---------------- Utils ----------------
const LS_KEY = "shiny_timer_v4";
const LS_PROFILE = "shiny_timer_profile";

function uid() {
  // good enough for client ids; server keeps uuid too
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function fmtHMS(sec = 0) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function toSeconds(h, m) {
  const H = Number(h) || 0; const M = Number(m) || 0;
  return Math.max(0, H) * 3600 + Math.max(0, M) * 60;
}

// pastel glass themes (Tailwind v4 classes kept in StyleTags safelist)
const THEMES = [
  { id: "glass-none", label: "Transparent", cls: "from-transparent to-transparent/0" },
  { id: "glass-blue", label: "Blue", cls: "from-blue-400/25 to-indigo-500/25" },
  { id: "glass-green", label: "Green", cls: "from-emerald-400/25 to-green-600/25" },
  { id: "glass-purple", label: "Purple", cls: "from-fuchsia-400/25 to-purple-600/25" },
  { id: "glass-gold", label: "Gold", cls: "from-amber-400/25 to-rose-500/25" },
  { id: "glass-red", label: "Red", cls: "from-rose-500/25 to-red-600/25" },
];

const DEFAULT_TIMERS = [
  { id: uid(), name: "Working Hour", targetSec: 11*3600, revisionSec: 0, elapsedSec: 0, startTs: null, running: false, goalOn: true, goalFired: false, category: "work", color: "from-slate-400/20 to-slate-600/20", sort_index: 0 },
  { id: uid(), name: "Music",       targetSec:  0*3600+60, revisionSec: 0, elapsedSec: 0, startTs: null, running: false, goalOn: true, goalFired: false, category: "neutral", color: "from-rose-400/20 to-rose-600/20", sort_index: 1 },
  { id: uid(), name: "Exercise",    targetSec:  1*3600, revisionSec: 0, elapsedSec: 0, startTs: null, running: false, goalOn: false, goalFired: false, category: "neutral", color: "from-emerald-400/20 to-green-600/20", sort_index: 2 },
  { id: uid(), name: "Learning",    targetSec:  2*3600, revisionSec: 0, elapsedSec: 0, startTs: null, running: false, goalOn: false, goalFired: false, category: "work", color: "from-cyan-400/20 to-blue-600/20", sort_index: 3 },
  { id: uid(), name: "Break Time",  targetSec:  28*60, revisionSec: 0, elapsedSec: 0, startTs: null, running: false, goalOn: true, goalFired: false, category: "break", color: "from-amber-400/20 to-orange-600/20", sort_index: 4 },
  { id: uid(), name: "Sleeping",    targetSec:  6*3600, revisionSec: 0, elapsedSec: 0, startTs: null, running: false, goalOn: true, goalFired: false, category: "neutral", color: "from-purple-400/20 to-violet-700/20", sort_index: 5 },
];

// ---------------- App ----------------
export default function App() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(() => {
    const s = localStorage.getItem(LS_PROFILE);
    return s ? JSON.parse(s) : { name: "Your Name", emoji: "🌟", photo: null };
  });
  const [timers, setTimers] = useState(() => {
    const s = localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : DEFAULT_TIMERS;
  });

  const [profileOpen, setProfileOpen] = useState(false);
  const [editTimer, setEditTimer] = useState(null);
  const [celebration, setCelebration] = useState(null); // {name,target}

  // local persistence
  useEffect(()=>{ localStorage.setItem(LS_KEY, JSON.stringify(timers)); }, [timers]);
  useEffect(()=>{ localStorage.setItem(LS_PROFILE, JSON.stringify(profile)); }, [profile]);

  // Supabase auth
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data } = await supabase.auth.getUser();
      setUser(data?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub?.subscription.unsubscribe();
  }, []);

  // ---------- Load from cloud on sign-in ----------
  useEffect(() => {
    if (!supabase || !user) return;
    (async () => {
      const { data: rows, error } = await supabase
        .from("timers").select("*")
        .eq("user_id", user.id)
        .order("sort_index", { ascending: true });

      if (!error) {
        if (!rows || rows.length === 0) {
          await upsertAllToCloud(user.id, timers);
        } else {
          const mapped = rows.map(r => ({
            id:r.id, name:r.name, targetSec:r.target_sec, revisionSec:r.revision_sec,
            elapsedSec:r.elapsed_sec, startTs:r.start_ts??null, running:r.running,
            goalOn:r.goal_on, goalFired:r.goal_fired, category:r.category, color:r.color, sort_index:r.sort_index??0
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

  // ---------- Realtime: timers ----------
  useEffect(() => {
    if (!supabase || !user) return;
    const channel = supabase
      .channel('timers-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'timers', filter: `user_id=eq.${user.id}` }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = payload.old?.id; if (!id) return;
          setTimers(prev => prev.filter(t => t.id !== id));
          return;
        }
        const r = payload.new; if (!r) return;
        const mapped = { id:r.id, name:r.name, category:r.category, targetSec:r.target_sec, revisionSec:r.revision_sec, elapsedSec:r.elapsed_sec, startTs:r.start_ts??null, running:r.running, goalOn:r.goal_on, goalFired:r.goal_fired, color:r.color, sort_index:r.sort_index??0 };
        setTimers(prev => {
          const i = prev.findIndex(t => t.id === r.id);
          const next = [...prev];
          if (i === -1) next.push(mapped); else next[i] = mapped;
          next.sort((a,b)=>(a.sort_index??0)-(b.sort_index??0));
          return next;
        });
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [user]);

  // ---------- Realtime: profile ----------
  useEffect(() => {
    if (!supabase || !user) return;
    const ch = supabase
      .channel('profiles-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `user_id=eq.${user.id}` }, (payload) => {
        const row = payload.new || payload.old; if (!row) return;
        setProfile({ name: row.name ?? "Your Name", emoji: row.emoji ?? "🌟", photo: row.photo ?? null });
      })
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [user]);

  // ---------- Debounced save timers ----------
  const saveDebounce = useRef();
  useEffect(() => {
    if (!supabase || !user) return;
    if (saveDebounce.current) clearTimeout(saveDebounce.current);
    saveDebounce.current = setTimeout(() => { upsertAllToCloud(user.id, timers); }, 400);
    return () => clearTimeout(saveDebounce.current);
  }, [timers, user]);

  // ---------- Save profile ----------
  useEffect(() => {
    if (!supabase || !user) return;
    (async () => { await supabase.from("profiles").upsert({ user_id:user.id, name: profile.name, emoji: profile.emoji, photo: profile.photo, updated_at:new Date().toISOString() }); })();
  }, [profile, user]);

  async function upsertAllToCloud(userId, list) {
    if (!supabase) return;
    const rows = list.map((t, idx) => ({ id:t.id, user_id:userId, name:t.name, target_sec:Math.floor(t.targetSec||0), revision_sec:Math.floor(t.revisionSec||0), elapsed_sec:Math.floor(t.elapsedSec||0), start_ts:t.startTs?Math.floor(t.startTs):null, running:!!t.running, goal_on:!!t.goalOn, goal_fired:!!t.goalFired, category:t.category, color:t.color, sort_index: idx, updated_at:new Date().toISOString() }));
    const { error } = await supabase.from("timers").upsert(rows, { onConflict:"id" }); if (error) console.error(error);
  }

  // ---------- Timer loop ----------
  useEffect(() => {
    const id = setInterval(() => {
      setTimers(prev => prev.map(t => {
        if (!t.running || t.startTs == null) return t;
        const now = Math.floor(Date.now()/1000);
        const elapsed = t.elapsedSec + (now - t.startTs);
        const net = Math.max(0, elapsed - (t.revisionSec||0));
        // fire celebration once
        if (t.goalOn && !t.goalFired && t.targetSec>0 && net >= t.targetSec) {
          setCelebration({ name: t.name, target: t.targetSec });
          return { ...t, goalFired: true, elapsedSec: elapsed };
        }
        return { ...t, elapsedSec: elapsed };
      }));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---------- Actions ----------
  function startTimer(id) {
    setTimers(prev => prev.map(t => t.id===id ? (t.running? t : { ...t, running:true, startTs: Math.floor(Date.now()/1000) }) : t));
  }
  function pauseTimer(id) {
    setTimers(prev => prev.map(t => {
      if (t.id !== id || !t.running) return t;
      const now = Math.floor(Date.now()/1000);
      const extra = now - (t.startTs||now);
      return { ...t, running:false, startTs:null, elapsedSec: t.elapsedSec + extra };
    }));
  }
  function resetTimer(id) {
    setTimers(prev => prev.map(t => t.id===id ? { ...t, running:false, startTs:null, elapsedSec:0, revisionSec:0, goalFired:false } : t));
  }
  async function removeTimer(id) {
    setTimers(prev => prev.filter(t => t.id !== id));
    setEditTimer(null);
    if (supabase && user) {
      await supabase.from('timers').delete().eq('user_id', user.id).eq('id', id);
    }
  }
  function addTimer() {
    const n = { id: uid(), name:"New Timer", targetSec:0, revisionSec:0, elapsedSec:0, startTs:null, running:false, goalOn:false, goalFired:false, category:"neutral", color:"from-slate-400/20 to-slate-700/20", sort_index: timers.length };
    setTimers(prev => [...prev, n]);
    setEditTimer(n);
  }
  function adjustTimer(id, deltaSec) {
    setTimers(prev => prev.map(t => t.id===id ? { ...t, revisionSec: Math.max(0, (t.revisionSec||0) - deltaSec) } : t));
  }
  function setTheme(id, cls) { setTimers(prev => prev.map(t => t.id===id?{...t, color:cls}:t)); }
  function setTarget(id, sec) { setTimers(prev => prev.map(t => t.id===id?{...t, targetSec:sec}:t)); }
  function setName(id, name) { setTimers(prev => prev.map(t => t.id===id?{...t, name}:t)); }
  function setGoal(id, on) { setTimers(prev => prev.map(t => t.id===id?{...t, goalOn:on}:t)); }
  function setCategory(id, c) { setTimers(prev => prev.map(t => t.id===id?{...t, category:c}:t)); }

  function resetDay() {
    setTimers(prev => prev.map(t => ({ ...t, running:false, startTs:null, elapsedSec:0, revisionSec:0, goalFired:false })));
  }

  function exportCSV() {
    const rows = [["Name","Seconds","Time"], ...timers.map(t => { const net = Math.max(0, (t.elapsedSec||0) - (t.revisionSec||0)); return [t.name, String(net), fmtHMS(net)]; })];
    const csv = rows.map(r => r.map(x => `"${String(x).replaceAll('"','""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type:"text/csv" });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `timers-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  }

  // drag & drop order
  const dragId = useRef(null);
  function onDragStart(e, id) { dragId.current = id; e.dataTransfer.effectAllowed = "move"; }
  function onDragOverList(e, overId) {
    e.preventDefault();
    const from = dragId.current; if (!from || from===overId) return;
    setTimers(prev => {
      const arr = [...prev];
      const i = arr.findIndex(t => t.id===from);
      const j = arr.findIndex(t => t.id===overId);
      if (i===-1 || j===-1) return prev;
      const [m] = arr.splice(i,1);
      arr.splice(j,0,m);
      return arr.map((t,idx)=>({ ...t, sort_index: idx }));
    });
  }

  // totals
  const totalTracked = useMemo(() => fmtHMS(timers.reduce((a,t)=> a + Math.max(0,(t.elapsedSec||0)-(t.revisionSec||0)),0)), [timers]);

  return (
    <div className="min-h-screen text-white selection:bg-cyan-500/30">
      {/* moving background highlight */}
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(1200px_600px_at_70%_-10%,rgba(255,255,255,0.09),transparent_60%)]" />

      <NavBar
        profile={profile}
        onOpenProfile={()=>setProfileOpen(true)}
        addTimer={addTimer}
        resetDay={resetDay}
        exportCSV={exportCSV}
        totalTracked={totalTracked}
        user={user}
      />

      {/* timers list */}
      <div className="max-w-5xl mx-auto px-4 pb-24">
        <div className="flex flex-col gap-6">
          {timers.map(t => {
            const netSeconds = Math.max(0, (t.elapsedSec||0) - (t.revisionSec||0));
            return (
              <TimerCard key={t.id} t={t}
                onDragStart={onDragStart}
                onDragOverItem={(e)=>onDragOverList(e, t.id)}
                onClick={()=>setEditTimer(t)}
                start={()=>startTimer(t.id)}
                pause={()=>pauseTimer(t.id)}
                reset={()=>resetTimer(t.id)}
                netSeconds={netSeconds}
                adjust={(delta)=>adjustTimer(t.id, delta)}
              />
            );
          })}
        </div>
      </div>

      {editTimer && (
        <Modal onClose={()=>setEditTimer(null)}>
          <TimerEditor
            t={editTimer}
            onClose={()=>setEditTimer(null)}
            onDelete={()=>removeTimer(editTimer.id)}
            onName={(v)=>setName(editTimer.id, v)}
            onTarget={(sec)=>setTarget(editTimer.id, sec)}
            onGoal={(on)=>setGoal(editTimer.id, on)}
            onCategory={(c)=>setCategory(editTimer.id, c)}
            onTheme={(cls)=>setTheme(editTimer.id, cls)}
          />
        </Modal>
      )}

      {profileOpen && (
        <Modal onClose={()=>setProfileOpen(false)}>
          <ProfileEditor profile={profile} onSave={(p)=>{ setProfile(p); setProfileOpen(false); }} />
        </Modal>
      )}

      {celebration && (
        <CelebrationOverlay name={celebration.name} target={celebration.target} onClose={()=>setCelebration(null)} />
      )}

      <StyleTags />
    </div>
  );
}

// ---------------- UI Bits ----------------
function NavBar({ profile, onOpenProfile, addTimer, resetDay, exportCSV, totalTracked, user }) {
  return (
    <div className="sticky top-0 z-30 backdrop-blur bg-slate-900/65 border-b border-white/10">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
        <button onClick={onOpenProfile} className="flex items-center gap-3 group">
          <div className="w-10 h-10 rounded-2xl bg-white/10 border border-white/15 grid place-items-center text-xl">{profile.emoji || "🌟"}</div>
          <div className="text-left">
            <div className="font-semibold">{profile.name || "Your Name"}</div>
            <div className="text-xs text-white/70">Time Tracker</div>
          </div>
        </button>

        <div className="flex items-center gap-2">
          <button onClick={addTimer} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-sky-500 to-blue-600 hover:brightness-110 active:scale-95 shadow">+ Add Timer</button>
          <button onClick={resetDay} className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15">Reset Day</button>
          <button onClick={exportCSV} className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15">Export CSV</button>
          <div className="text-white/80 text-sm pl-2">Total tracked: <span className="time-mono">{totalTracked}</span></div>
        </div>
      </div>
    </div>
  );
}

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
      {/* preserve theme gradient; hover glow separate layer */}
      <div className="pointer-events-none absolute inset-0 rounded-3xl" style={{ background: `radial-gradient(600px circle at ${xy.x}% ${xy.y}%, rgba(255,255,255,0.10), transparent 40%)` }} />

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
          <button onClick={(e)=>{ e.stopPropagation(); running? pause(): start(); }} className={`w-11 h-11 rounded-full grid place-items-center text-xl text-white shadow-lg transition ${running? "bg-gradient-to-tr from-rose-500 to-red-500" : "bg-gradient-to-tr from-lime-500 to-green-600"}`}>{running? "❚❚" : "►"}</button>
          <button onClick={(e)=>{ e.stopPropagation(); reset(); }} className="px-3 py-2 rounded-xl bg-white/10 text-white/90 hover:bg-white/20 border border-white/10">Reset</button>
        </div>
      </div>

      {/* Quick adjust */}
      <QuickAdjust onAdd={(s)=>adjust(+s)} onSub={(s)=>adjust(-s)} />

      {/* Shine */}
      <div className="pointer-events-none absolute inset-0 rounded-3xl overflow-hidden">
        <div className="absolute -inset-[40%] rotate-12 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-120%] group-hover:animate-card-shine" />
      </div>
    </div>
  );
}

function QuickAdjust({ onAdd, onSub }) {
  const [h, setH] = useState(0); const [m, setM] = useState(0);
  function fire(delta) { const s = toSeconds(h, m); if (s>0) { delta>0? onAdd(s): onSub(s); setH(0); setM(0); } }
  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-white/80">
      <span className="opacity-80">Adjust:</span>
      <input type="number" className="w-16 px-2 py-1 rounded-lg bg-white/10 border border-white/10" value={h} onChange={e=>setH(e.target.value)} min={0} />
      <span>:</span>
      <input type="number" className="w-16 px-2 py-1 rounded-lg bg-white/10 border border-white/10" value={m} onChange={e=>setM(e.target.value)} min={0} />
      <button onClick={(e)=>{e.stopPropagation(); fire(+1);}} className="px-3 py-1 rounded-lg bg-green-600/80 hover:bg-green-500">Add</button>
      <button onClick={(e)=>{e.stopPropagation(); fire(-1);}} className="px-3 py-1 rounded-lg bg-rose-600/80 hover:bg-rose-500">Subtract</button>
    </div>
  );
}

function TimerEditor({ t, onClose, onDelete, onName, onTarget, onGoal, onCategory, onTheme }) {
  const [name, setNameLocal] = useState(t.name);
  const [th, setTh] = useState(Math.floor((t.targetSec||0)/3600));
  const [tm, setTm] = useState(Math.floor(((t.targetSec||0)%3600)/60));
  const [goal, setGoalLocal] = useState(!!t.goalOn);
  const [cat, setCat] = useState(t.category||"neutral");
  const [theme, setThemeLocal] = useState(t.color);

  function save() {
    onName(name);
    onTarget(toSeconds(th, tm));
    onGoal(goal);
    onCategory(cat);
    onTheme(theme);
    onClose();
  }

  return (
    <div className="w-[min(720px,95vw)]">
      <h2 className="text-2xl font-semibold mb-4">Edit Time Info</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm mb-1">Name</label>
          <input value={name} onChange={e=>setNameLocal(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/10 border border-white/10" />
        </div>
        <div>
          <label className="block text-sm mb-1">Category</label>
          <div className="flex gap-2">
            {['work','break','neutral'].map(c => (
              <button key={c} onClick={()=>setCat(c)} className={`px-3 py-2 rounded-xl border ${cat===c? 'bg-white/20 border-white/20' : 'bg-white/10 border-white/10'}`}>{c[0].toUpperCase()+c.slice(1)}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm mb-1">Target Time (H : M)</label>
          <div className="flex items-center gap-2">
            <input type="number" className="w-24 px-2 py-2 rounded-xl bg-white/10 border border-white/10" value={th} onChange={e=>setTh(e.target.value)} />
            <span>:</span>
            <input type="number" className="w-24 px-2 py-2 rounded-xl bg-white/10 border border-white/10" value={tm} onChange={e=>setTm(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="block text-sm mb-1">Goal Celebration</label>
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" className="hidden" checked={goal} onChange={e=>setGoalLocal(e.target.checked)} />
            <span className={`w-12 h-6 rounded-full p-1 transition ${goal?'bg-emerald-500':'bg-white/20'}`}>
              <span className={`block w-4 h-4 rounded-full bg-white transition ${goal?'translate-x-6':''}`} />
            </span>
            <span>Celebrate when reaching target</span>
          </label>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-sm mb-2">Theme</div>
        <div className="grid grid-cols-6 gap-2">
          {THEMES.map(thm => (
            <button key={thm.id} onClick={()=>setThemeLocal(thm.cls)}
              className={`h-10 rounded-xl border ${theme===thm.cls? 'border-white/60' : 'border-white/15'} bg-gradient-to-br ${thm.cls}`} />
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 justify-between">
        <button onClick={save} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 active:scale-95">Save & Close</button>
        <button onClick={onDelete} className="px-4 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-500">Delete</button>
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onSave }) {
  const [name, setName] = useState(profile.name || "Your Name");
  const [emoji, setEmoji] = useState(profile.emoji || "🌟");
  return (
    <div className="w-[min(560px,95vw)]">
      <h2 className="text-2xl font-semibold mb-4">Profile</h2>
      <div className="grid gap-4">
        <div>
          <label className="block text-sm mb-1">Name</label>
          <input value={name} onChange={e=>setName(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/10 border border-white/10" />
        </div>
        <div>
          <label className="block text-sm mb-1">Emoji</label>
          <input value={emoji} onChange={e=>setEmoji(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/10 border border-white/10" />
        </div>
      </div>
      <div className="mt-6 flex items-center gap-2 justify-between">
        <button onClick={()=>onSave({ name, emoji, photo:null })} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 active:scale-95">Save</button>
        <AuthPanel />
      </div>
    </div>
  );
}

function AuthPanel() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);

  async function sendLink() {
    if (!supabase) { alert("Supabase env vars missing."); return; }
    setErr(""); setSending(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: window.location.origin } });
    setSending(false);
    if (error) setErr(error.message); else setSent(true);
  }
  async function signOut() { await supabase?.auth.signOut(); }

  return (
    <div className="flex items-center gap-2">
      <input type="email" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} className="px-3 py-2 rounded-xl bg-white/10 border border-white/10" />
      <button onClick={sendLink} disabled={!email || sending} className="px-3 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500 active:scale-95 disabled:opacity-60">{sending?"Sending...": sent?"Link sent ✓":"Send magic link"}</button>
      <button onClick={signOut} className="px-3 py-2 rounded-xl bg-white/10 border border-white/10">Sign out</button>
      {err && <div className="text-rose-400 text-sm ml-2">{err}</div>}
    </div>
  );
}

function Modal({ children, onClose }) {
  useEffect(() => {
    function onKey(e){ if (e.key==='Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center px-4" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-slate-900/90 border border-white/15 rounded-3xl p-5 backdrop-blur w-full max-w-3xl" onMouseDown={e=>e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 w-9 h-9 rounded-xl bg-white/10 border border-white/10">✕</button>
        {children}
      </div>
    </div>
  );
}

function CelebrationOverlay({ name, target, onClose }) {
  useEffect(() => {
    const pieces = 180;
    for (let i=0;i<pieces;i++) {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.setProperty('--left', Math.random()*100 + 'vw');
      el.style.setProperty('--size', (6+Math.random()*6)+'px');
      el.style.setProperty('--rotate', (Math.random()*360)+'deg');
      el.style.setProperty('--duration', (2.5+Math.random()*1.8)+'s');
      document.body.appendChild(el);
      setTimeout(()=>el.remove(), 4200);
    }
  }, []);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative text-center">
        <div className="text-5xl sm:text-6xl font-extrabold bg-gradient-to-r from-pink-300 via-white to-cyan-200 bg-clip-text text-transparent glow-text">Congratulations!</div>
        <div className="mt-3 text-white/90 text-xl">You reached your goal for <span className="font-semibold">{name}</span> ({fmtHMS(target)}).</div>
        <div className="mt-6 text-white/80">Click anywhere to dismiss</div>
      </div>
    </div>
  );
}

// ---------------- Global styles ----------------
function StyleTags() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Monomakh:wght@600&display=swap');
      html,body,#root{height:100%}
      body{background:#0b1220}
      @keyframes gradientMove { 0%{background-position:0% 0%} 50%{background-position:100% 100%} 100%{background-position:0% 0%} }
      .animate-gradient { background-size:200% 200%; animation: gradientMove 18s ease infinite; }
      @keyframes shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
      .animate-shimmer { background-size:200% 100%; animation: shimmer 14s linear infinite; }
      @keyframes cardShine { 0%{ transform: translateX(-120%) rotate(12deg);} 100%{ transform: translateX(120%) rotate(12deg);} }
      .animate-card-shine { animation: cardShine 1.1s ease forwards; }
      .time-mono { font-family: "Monomakh", sans-serif; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 2rem; }
      .confetti-piece { position: fixed; top: -10vh; left: var(--left); width: var(--size); height: var(--size); background: hsl(var(--h,0),95%,60%); transform: rotate(var(--rotate)); animation: confettiFall var(--duration) ease-out forwards, confettiSpin calc(var(--duration)*0.8) linear infinite; z-index: 9999; border-radius: 2px; box-shadow: 0 0 0 1px rgba(255,255,255,0.15) inset; }
      .confetti-piece:nth-child(5n) { --h: 190 } .confetti-piece:nth-child(5n+1) { --h: 140 } .confetti-piece:nth-child(5n+2) { --h: 40 } .confetti-piece:nth-child(5n+3) { --h: 320 } .confetti-piece:nth-child(5n+4) { --h: 260 }
      @keyframes confettiFall { 0%{ transform: translateY(-10vh) rotate(var(--rotate)); opacity:1 } 100%{ transform: translateY(110vh) rotate(calc(var(--rotate) + 360deg)); opacity:.9 } }
      @keyframes confettiSpin { from { filter: brightness(1) } to { filter: brightness(1.2) } }
      .glow-text { filter: drop-shadow(0 0 14px rgba(255,255,255,0.25)) drop-shadow(0 0 34px rgba(255,255,255,0.15)); }
      @keyframes glow { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      .animate-glow { animation: glow 8s ease infinite; }
      /* Keep dynamic gradient classes alive for Tailwind v4 tree-shake */
      .safelist { display:none }
      .safelist:where(.x){
        background-image: linear-gradient(to bottom right, var(--tw-gradient-stops));
      }
      /* classes to preserve */
      .keep-1{ background-image: linear-gradient(to bottom right, rgb(96 165 250 / 0.25), rgb(79 70 229 / 0.25)); }
      .keep-2{ background-image: linear-gradient(to bottom right, rgb(110 231 183 / 0.25), rgb(22 163 74 / 0.25)); }
      .keep-3{ background-image: linear-gradient(to bottom right, rgb(232 121 249 / 0.25), rgb(147 51 234 / 0.25)); }
      .keep-4{ background-image: linear-gradient(to bottom right, rgb(251 191 36 / 0.25), rgb(244 63 94 / 0.25)); }
      .keep-5{ background-image: linear-gradient(to bottom right, rgb(248 113 113 / 0.25), rgb(220 38 38 / 0.25)); }
      .keep-6{ background-image: linear-gradient(to bottom right, rgb(148 163 184 / 0.2), rgb(51 65 85 / 0.2)); }
    `}</style>
  );
}
