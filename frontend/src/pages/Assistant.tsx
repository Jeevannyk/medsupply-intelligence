import { useRef, useState } from "react";
import { Bot, Send, Sparkles, User } from "lucide-react";
import { post, type AssistantReply } from "../api";
import { Button, Card, Input, Pill } from "../components/ui";
import { useApp } from "../context";

const SAMPLES = ["Which hospitals are at highest shortage risk next week?", "What will expire unused?", "Why move oseltamivir to Wenlock?",
  "Who should get ceftriaxone first?", "Check the 20,000 unit scenario", "Is there an outbreak?"];

export function AssistantPanel({ compact = false }: { compact?: boolean }) {
  const { scenario } = useApp();
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ q: string; r?: AssistantReply; err?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setQ("");
    try {
      const r = await post<AssistantReply>("/assistant", { question, scenario });
      setLog((l) => [...l, { q: question, r }]);
    } catch (e) {
      setLog((l) => [...l, { q: question, err: (e as Error).message }]);
    }
    setBusy(false);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };
  return (
    <Card title="Clinical decision copilot" icon={<Bot size={18} />}
      subtitle="Answers only from backend tool data (Gemini function-calling if a key is set, otherwise grounded templates)">
      <div className={`${compact ? "max-h-72" : "max-h-[520px] min-h-64"} space-y-4 overflow-y-auto rounded-xl bg-slate-50/70 p-4 scroll-thin`}>
        {log.length === 0 && (
          <div className="py-6 text-center text-sm text-muted"><Sparkles className="mx-auto mb-2 text-brand" size={26} />Ask about shortages, expiry, transfers or priorities. Try a suggestion below.</div>
        )}
        {log.map((x, i) => (
          <div key={i} className="space-y-2">
            <div className="flex justify-end gap-2"><p className="max-w-[80%] rounded-2xl rounded-tr-sm bg-brand px-3.5 py-2 text-sm text-white shadow">{x.q}</p><User size={20} className="mt-1 shrink-0 text-muted" /></div>
            <div className="flex gap-2">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"><Bot size={15} /></span>
              <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-line bg-white px-3.5 py-2.5 text-sm shadow-sm">
                {x.err ? <p className="text-red-700">{x.err}</p> : (
                  <>
                    <p className="whitespace-pre-wrap leading-6">{x.r!.answer}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Pill tone="slate">mode: {x.r!.mode}</Pill>
                      {x.r!.tools.map((t) => <Pill key={t.name} tone="brand">{t.name}</Pill>)}
                      {x.r!.note && <span className="text-[11px] text-muted">{x.r!.note}</span>}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
        {busy && <p className="live-dot text-xs text-muted">Thinking…</p>}
        <div ref={end} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {SAMPLES.slice(0, compact ? 3 : 6).map((s) => (
          <button key={s} onClick={() => ask(s)} className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink">{s}</button>
        ))}
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <Input className="flex-1" placeholder="Ask about shortages, expiry, transfers, priorities…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" icon={<Send size={15} />} loading={busy}>Ask</Button>
      </form>
    </Card>
  );
}

export default function AssistantPage() {
  return <AssistantPanel />;
}
