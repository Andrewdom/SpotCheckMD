"use client";

import { Activity, LoaderCircle, LockKeyhole } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

export default function SignInPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"expired" | "signed-out" | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setNotice(query.get("reason") === "expired" ? "expired" : query.get("signedOut") ? "signed-out" : null);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }), cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Sign-in failed.");
      window.location.assign("/");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }
  return <main className="grid min-h-screen bg-[#f8f7f5] text-[#292524] lg:grid-cols-[minmax(0,1.2fr)_minmax(420px,.8fr)]">
    <section className="hidden border-r border-[#e6e1dd] bg-[#f2efed] p-12 lg:flex lg:flex-col lg:justify-between">
      <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-[#51384a] text-white"><Activity size={20} /></span><div><p className="text-base font-bold tracking-[.12em]">AURA</p><p className="text-[11px] text-[#77706d]">Clinical workspace</p></div></div>
      <div className="max-w-xl"><p className="text-sm font-medium text-[#716966]">Your clinical workspace</p><h1 className="mt-3 text-5xl font-semibold tracking-[-.045em]">Your notes, ready when you are.</h1><p className="mt-5 max-w-lg text-sm leading-7 text-[#77706d]">Consultation audio, images, chart context, evidence review, and SOAP documentation stay together across signed-in devices.</p></div>
      <p className="text-xs text-[#918986]">Synthetic demonstration</p>
    </section>
    <section className="flex items-center justify-center px-5 py-12 sm:px-10"><div className="w-full max-w-md">
      <div className="mb-10 flex items-center gap-3 lg:hidden"><span className="flex size-10 items-center justify-center rounded-xl bg-[#51384a] text-white"><Activity size={20} /></span><p className="font-bold tracking-[.12em]">AURA</p></div>
      <span className="flex size-11 items-center justify-center rounded-2xl bg-[#f0e7ed] text-[#66485d]"><LockKeyhole size={20} /></span>
      <h2 className="mt-6 text-3xl font-semibold tracking-[-.035em]">Welcome back</h2>
      <p className="mt-2 text-sm text-[#817976]">Sign in with your physician account.</p>
      {notice === "expired" && <p className="mt-4 rounded-xl border border-[#ead8bd] bg-[#fff8eb] p-3 text-sm text-[#805b1f]">Your session expired. Sign in again.</p>}
      {notice === "signed-out" && <p className="mt-4 rounded-xl border border-[#cfe2d4] bg-[#edf7f0] p-3 text-sm text-[#39704a]">You have signed out.</p>}
      {error && <p role="alert" className="mt-4 rounded-xl border border-[#f1c8c2] bg-[#fff5f3] p-3 text-sm text-[#8f3d34]">{error}</p>}
      <form onSubmit={submit} className="mt-8 space-y-4">
        <label className="block text-xs font-semibold text-[#625a57]">Username<input required autoComplete="username" autoFocus value={username} onChange={event => setUsername(event.target.value)} className="mt-2 w-full rounded-xl border border-[#d8d1cd] bg-white px-4 py-3 text-sm font-normal outline-none focus:border-[#9a708d]" /></label>
        <label className="block text-xs font-semibold text-[#625a57]">Password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[#d8d1cd] bg-white px-4 py-3 text-sm font-normal outline-none focus:border-[#9a708d]" /></label>
        <button disabled={busy || !username || !password} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#51384a] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#3f2939] disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle className="animate-spin" size={16} /> : <LockKeyhole size={16} />}{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="mt-6 text-[11px] leading-5 text-[#918986]">Use fictional patient information in this research workspace.</p>
    </div></section>
  </main>;
}
