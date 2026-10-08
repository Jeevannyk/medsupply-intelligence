import { useState } from "react";
import { Bot, Send, X } from "lucide-react";
import { useApp } from "../context";
import { ChatLog, SAMPLES, useChat } from "../pages/Assistant";
import { Button, Input } from "./ui";

const BY_PAGE: Record<string, string[]> = {
  "/shortage": ["Which hospitals are at highest shortage risk next week?", "Is there an outbreak?"],
  "/expiry": ["What will expire unused?", "Why move oseltamivir to Wenlock?"],
  "/redistribution": ["Why move oseltamivir to Wenlock?", "Who should get ceftriaxone first?"],
  "/priority": ["Who should get ceftriaxone first?", "Which hospitals are at highest shortage risk next week?"],
  "/demand": ["Is there an outbreak?", "How much oseltamivir will we need in the next 7 days?"],
  "/scenario": ["Check the 20,000 unit scenario", "Is there an outbreak?"],
};

export default function CopilotDock({ open, onClose, path }: { open: boolean; onClose: () => void; path: string }) {
  const { scenario } = useApp();
  const { log, busy, ask, end } = useChat(scenario);
  const [q, setQ] = useState("");
  const submit = (text: string) => { setQ(""); ask(text); };
  const samples = BY_PAGE[path] ?? SAMPLES.slice(0, 3);

  return (
    <aside aria-label="Sentinel assistant" aria-hidden={!open}
      className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-line bg-white shadow-2xl transition-transform duration-200 xl:z-30 xl:w-96 xl:max-w-none xl:shadow-none ${open ? "translate-x-0" : "pointer-events-none translate-x-full"}`}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand"><Bot size={18} /></span>
        <div className="mr-auto leading-tight">
          <h2 className="text-sm font-semibold tracking-tight">Sentinel</h2>
          <p className="text-[11px] text-muted">Answers from live backend data</p>
        </div>
        <button className="rounded-lg p-1.5 text-muted hover:bg-slate-100" onClick={onClose} aria-label="Close Sentinel"><X size={18} /></button>
      </header>
      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto bg-slate-50/70 p-4">
        <ChatLog log={log} busy={busy} end={end} empty="Ask about shortages, expiry, transfers or priorities." />
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {samples.map((s) => (
            <button key={s} onClick={() => submit(s)} className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink">{s}</button>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <Input className="min-w-0 flex-1" placeholder="Ask Sentinel…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" size="md" icon={<Send size={15} />} loading={busy} />
        </form>
      </div>
    </aside>
  );
}
