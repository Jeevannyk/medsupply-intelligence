import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Send, Sparkles, User } from "lucide-react";
import { post, type AssistantReply, type Scenario } from "../api";
import { Button, Card, Input, Pill } from "../components/ui";
import { useApp } from "../context";

export const SAMPLES = ["Which hospitals are at highest shortage risk next week?", "What will expire unused?", "Why move oseltamivir to Wenlock?",
  "Who should get ceftriaxone first?", "Check the 20,000 unit scenario", "Is there an outbreak?"];

type Entry = { q: string; r?: AssistantReply; err?: string };

export function useChat(scenario: Scenario) {
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);   // question shown the moment it is asked
  const end = useRef<HTMLDivElement>(null);
  const toEnd = (smooth = true) => end.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "nearest" });
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setPending(question);
    setTimeout(toEnd, 30);
    try {
      const r = await post<AssistantReply>("/assistant", { question, scenario });
      setLog((l) => [...l, { q: question, r }]);
    } catch (e) {
      setLog((l) => [...l, { q: question, err: (e as Error).message }]);
    }
    setPending(null);
    setBusy(false);
    setTimeout(toEnd, 30);
  };
  return { log, busy, pending, ask, end, toEnd };
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Bold (**x**) and bullet lists, no raw markdown characters on screen. */
export function Markdown({ text }: { text: string }) {
  const bold = (s: string): ReactNode[] => s.split(/\*\*(.+?)\*\*/g).map((p, i) => (i % 2 ? <b key={i} className="font-semibold">{p}</b> : p));
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) {
      blocks.push(<ul key={`u${blocks.length}`} className="my-1.5 list-disc space-y-1 pl-5 marker:text-brand">{items.map((t, i) => <li key={i}>{bold(t)}</li>)}</ul>);
      items = [];
    }
  };
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[*•-])\s+(.*)$/);
    if (m) items.push(m[1]);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`} className="my-1">{bold(line)}</p>);
    }
  }
  flush();
  return <div className="leading-6">{blocks}</div>;
}

/** Reveals the answer in quick chunks (bold pairs stay whole) so it reads like it is being written. */
function Answer({ r, animate, onTick }: { r: AssistantReply; animate: boolean; onTick: () => void }) {
  const tokens = r.answer.match(/\*\*.+?\*\*|\n|[ \t]+|[^\s]+/g) ?? [r.answer];
  const instant = !animate || reduceMotion();
  const [n, setN] = useState(instant ? tokens.length : 0);
  const done = n >= tokens.length;
  useEffect(() => {
    if (instant) return;
    const ms = 28;
    const step = Math.max(2, Math.ceil(tokens.length / (Math.min(2400, Math.max(700, tokens.length * 9)) / ms)));
    const t = setInterval(() => {
      setN((v) => {
        const next = Math.min(v + step, tokens.length);
        if (next >= tokens.length) clearInterval(t);
        return next;
      });
      onTick();
    }, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (done) onTick(); }, [done]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Markdown text={tokens.slice(0, n).join("")} />
      {!done && <i className="live-dot ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 bg-brand" />}
      {done && (
        <div className="rise mt-2 flex flex-wrap items-center gap-1.5">
          <Pill tone="slate">mode: {r.mode}</Pill>
          {r.tools.map((t) => <Pill key={t.name} tone="brand">{t.name}</Pill>)}
          {r.note && <span className="text-[11px] text-muted">{r.note}</span>}
        </div>
      )}
    </>
  );
}

const Question = ({ q }: { q: string }) => (
  <div className="rise flex justify-end gap-2">
    <p className="max-w-[80%] rounded-2xl rounded-tr-sm bg-brand px-3.5 py-2 text-sm text-white shadow">{q}</p>
    <User size={20} className="mt-1 shrink-0 text-muted" />
  </div>
);

const Avatar = () => <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"><Bot size={15} /></span>;

export function ChatLog({ log, pending, end, toEnd, empty }: {
  log: Entry[]; pending: string | null; end: React.RefObject<HTMLDivElement | null>; toEnd: (smooth?: boolean) => void; empty: string;
}) {
  return (
    <>
      {log.length === 0 && !pending && (
        <div className="py-6 text-center text-sm text-muted"><Sparkles className="mx-auto mb-2 text-brand" size={26} />{empty}</div>
      )}
      {log.map((x, i) => (
        <div key={i} className="space-y-2">
          <Question q={x.q} />
          <div className="rise flex gap-2">
            <Avatar />
            <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-line bg-white px-3.5 py-2.5 text-sm shadow-sm">
              {x.err ? <p className="text-red-700">{x.err}</p> : <Answer r={x.r!} animate={i === log.length - 1} onTick={() => toEnd(false)} />}
            </div>
          </div>
        </div>
      ))}
      {pending && (
        <div className="space-y-2">
          <Question q={pending} />
          <div className="rise flex gap-2">
            <Avatar />
            <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-line bg-white px-3.5 py-3 text-xs text-muted shadow-sm">
              <span className="flex gap-1">
                {[0, 1, 2].map((d) => <i key={d} className="size-1.5 animate-bounce rounded-full bg-brand" style={{ animationDelay: `${d * 140}ms` }} />)}
              </span>
              Reading live hospital data…
            </div>
          </div>
        </div>
      )}
      <div ref={end} />
    </>
  );
}

export default function AssistantPage() {
  const { scenario } = useApp();
  const { log, busy, pending, ask, end, toEnd } = useChat(scenario);
  const [q, setQ] = useState("");
  const submit = (text: string) => { setQ(""); ask(text); };
  return (
    <Card title="Sentinel" icon={<Bot size={18} />}
      subtitle="Answers only from backend tool data (Gemini function-calling if a key is set, otherwise grounded templates)">
      <div className="max-h-[520px] min-h-64 space-y-4 overflow-y-auto rounded-xl bg-slate-50/70 p-4 scroll-thin">
        <ChatLog log={log} pending={pending} end={end} toEnd={toEnd} empty="Ask about shortages, expiry, transfers or priorities. Try a suggestion below." />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {SAMPLES.map((s) => (
          <button key={s} onClick={() => submit(s)} className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink">{s}</button>
        ))}
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(q); }}>
        <Input className="flex-1" placeholder="Ask about shortages, expiry, transfers, priorities…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" icon={<Send size={15} />} loading={busy}>Ask</Button>
      </form>
    </Card>
  );
}
