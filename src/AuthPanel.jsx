import { useState } from 'react'
import { supabase } from './supabaseClient'

export default function AuthPanel({ user, onClose }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')

  async function sendLink() {
    setErr('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    if (error) setErr(error.message); else setSent(true)
  }

  async function signOut() { await supabase.auth.signOut() }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose}/>
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900/90 p-5 text-white">
          <button className="absolute right-3 top-3" onClick={onClose}>✕</button>
          {user ? (
            <div className="space-y-3">
              <div>Signed in as <span className="font-semibold">{user.email}</span></div>
              <button onClick={signOut} className="px-4 py-2 rounded-xl bg-gradient-to-tr from-rose-500 to-red-600">Sign out</button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-lg font-semibold">Sign in</div>
              <input className="w-full rounded-xl bg-white/10 border border-white/15 px-3 py-2"
                     placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} />
              <button onClick={sendLink} className="w-full px-4 py-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-500">Send magic link</button>
              {sent && <div className="text-emerald-300 text-sm">Check your email and tap the link.</div>}
              {err && <div className="text-rose-300 text-sm">{err}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
