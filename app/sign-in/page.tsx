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
  return <main className="flex min-h-screen items-center justify-center bg-[#f3f7f7] px-5 py-12 text-slate-800">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/50 sm:p-9">
      <div className="flex items-center gap-3"><span className="rounded-xl bg-[#11383c] p-2.5 text-teal-200"><Activity size={22} /></span><div><p className="text-lg font-bold tracking-[.14em]">AURA</p><p className="text-[10px] font-medium tracking-[.17em] text-teal-700">VISUAL SCRIBE</p></div></div>
      <div className="mt-8 flex size-11 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><LockKeyhole size={21} /></div>
      <h1 className="mt-4 text-2xl font-semibold">Physician sign-in</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">Access your shared fictional-patient workspace from this device.</p>
      {notice === "expired" && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Your session expired. Sign in again.</p>}
      {notice === "signed-out" && <p className="mt-4 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">You have signed out.</p>}
      {error && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm font-semibold">Username<input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100" /></label>
        <label className="block text-sm font-semibold">Password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100" /></label>
        <button disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-teal-800 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-900 disabled:opacity-50">{busy && <LoaderCircle className="animate-spin" size={16} />} {busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="mt-6 border-t border-slate-100 pt-5 text-[11px] leading-5 text-slate-500">Synthetic demonstration only. Do not enter real patient information.</p>
    </section>
  </main>;
}
