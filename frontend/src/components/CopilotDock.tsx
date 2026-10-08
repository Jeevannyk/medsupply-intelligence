import { useRef, useState } from "react";
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

// progressive resistance past the edge instead of a hard stop
const rubberband = (over: number, dim: number, c = 0.55) => (Math.sign(over) * Math.abs(over) * dim * c) / (dim + c * Math.abs(over));
// where a flick will come to rest (exponential deceleration), px
const project = (v: number, rate = 0.998) => ((v / 1000) * rate) / (1 - rate);

export default function CopilotDock({ open, onClose, path }: { open: boolean; onClose: () => void; path: string }) {
  const { scenario } = useApp();
  const { log, busy, ask, end } = useChat(scenario);
  const [q, setQ] = useState("");
  const submit = (text: string) => { setQ(""); ask(text); };
  const samples = BY_PAGE[path] ?? SAMPLES.slice(0, 3);
  const [dragX, setDragX] = useState<number | null>(null);
  const track = useRef<{ x0: number; pts: { x: number; t: number }[] } | null>(null);

  const down = (e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    track.current = { x0: e.clientX, pts: [{ x: e.clientX, t: performance.now() }] };
    setDragX(0);
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const s = track.current;
    if (!s) return;
    s.pts = [...s.pts.slice(-4), { x: e.clientX, t: performance.now() }];
    const dx = e.clientX - s.x0;
    setDragX(dx >= 0 ? dx : rubberband(dx, 380));
  };
  const up = () => {
    const s = track.current;
    track.current = null;
    if (!s) return;
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    const v = b.t > a.t ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0;
    const dx = b.x - s.x0;
    // commit on where the gesture is heading (momentum projection), not where it was released
    if (dx + project(v) > 190) onClose();
    setDragX(null);
  };

  return (
    <aside aria-label="Sentinel assistant" aria-hidden={!open}
      style={dragX !== null ? { transform: `translateX(${dragX}px)` } : undefined}
      className={`dock glass fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-line shadow-2xl ease-[cubic-bezier(0.32,0.72,0,1)] xl:z-30 xl:w-96 xl:max-w-none xl:shadow-none ${
        dragX !== null ? "transition-none" : "transition-[translate,transform,opacity] duration-[380ms]"} ${
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0"}`}>
      <header className="flex cursor-grab touch-pan-y items-center gap-3 border-b border-line px-4 py-3.5 select-none active:cursor-grabbing"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
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
