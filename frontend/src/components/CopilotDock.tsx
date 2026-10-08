import { useEffect, useRef, useState } from "react";
import { Bot, Send, Sparkles, X } from "lucide-react";
import { useApp } from "../context";
import { ChatLog, SAMPLES, useChat } from "../pages/Assistant";
import { Button, Input } from "./ui";

const BY_PAGE: Record<string, string[]> = {
  "/shortage": ["Which hospitals are at highest shortage risk next week?", "Is there an outbreak?"],
  "/expiry": ["What will expire unused?", "Why move oseltamivir to Wenlock?"],
  "/redistribution": ["Why move oseltamivir to Wenlock?", "Who should get ceftriaxone first?"],
  "/priority": ["Who should get ceftriaxone first?", "Which hospitals are at highest shortage risk next week?"],
  "/demand": ["Is there an outbreak?", "How much oseltamivir will we need in the next 7 days?"],
};

/** Floating launcher + chat card. The card grows out of the launcher corner; it overlays the page, never pushes it. */
export default function CopilotDock({ open, onOpen, onClose, path }: { open: boolean; onOpen: () => void; onClose: () => void; path: string }) {
  const { scenario } = useApp();
  const { log, busy, pending, ask, end, toEnd } = useChat(scenario);
  const [q, setQ] = useState("");
  const submit = (text: string) => { setQ(""); ask(text); };
  const samples = BY_PAGE[path] ?? SAMPLES.slice(0, 3);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => document.getElementById("sentinel-input")?.focus(), 260);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", esc);
    return () => { clearTimeout(t); window.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <>
      <button onClick={onOpen} aria-label="Ask Sentinel" tabIndex={open ? -1 : 0}
        className={`btn-primary group fixed right-5 bottom-5 z-40 flex h-12 items-center gap-2 rounded-full pr-4 pl-3 text-sm font-semibold text-white origin-bottom-right transition-all duration-200 motion-reduce:transition-none ${
          open ? "pointer-events-none scale-50 opacity-0" : "scale-100 opacity-100 hover:-translate-y-0.5 active:scale-95"}`}>
        <span className="grid size-7 place-items-center rounded-full bg-white/20"><Sparkles size={16} /></span>
        Ask Sentinel
        <span className="live-dot absolute -top-0.5 -right-0.5 size-3 rounded-full bg-emerald-400 ring-2 ring-white" />
      </button>

      <aside role="dialog" aria-label="Sentinel assistant" aria-hidden={!open}
        className={`fixed right-5 bottom-5 z-40 flex h-[min(36rem,calc(100vh-2.5rem))] w-[min(26rem,calc(100vw-2.5rem))] origin-bottom-right flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.45,0.64,1)] motion-reduce:transition-none ${
          open ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-3 scale-[0.6] opacity-0"}`}>
        <header className="flex items-center gap-3 border-b border-line bg-white px-4 py-3">
          <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand"><Bot size={18} /></span>
          <div className="mr-auto leading-tight">
            <h2 className="text-sm font-semibold tracking-tight">Sentinel</h2>
            <p className="flex items-center gap-1.5 text-[11px] text-muted"><i className="live-dot size-1.5 rounded-full bg-emerald-500" />Answers from live backend data</p>
          </div>
          <button className="rounded-lg p-1.5 text-muted hover:bg-slate-100" onClick={onClose} aria-label="Close Sentinel" tabIndex={open ? 0 : -1}><X size={18} /></button>
        </header>
        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto bg-slate-50 p-4">
          <ChatLog log={log} pending={pending} end={end} toEnd={toEnd} empty="Ask about shortages, expiry, transfers or priorities." />
        </div>
        <div className="border-t border-line bg-white p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {samples.map((s) => (
              <button key={s} onClick={() => submit(s)} tabIndex={open ? 0 : -1} disabled={busy}
                className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink disabled:opacity-50">{s}</button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(q); }}>
            <Input id="sentinel-input" className="min-w-0 flex-1" placeholder="Ask Sentinel…" value={q} tabIndex={open ? 0 : -1} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" size="md" icon={<Send size={15} />} loading={busy} />
          </form>
        </div>
      </aside>
    </>
  );
}
