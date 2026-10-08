import { useEffect, useState } from "react";
import { ArrowRight, Send, Share2 } from "lucide-react";
import { post } from "../api";
import { NetworkMap } from "../components/charts";
import { Button, Card, Empty, Pill, Select, fmt } from "../components/ui";
import { useApp } from "../context";
import { go } from "../router";

export interface MoveSelection {
  picked: Set<string>; toggle: (key: string) => void; send: (keys: string[]) => void; canSend: boolean; busy: boolean;
}

export function MoveCards({ filter, limit, select, onFocus }: {
  filter: string; limit?: number; select?: MoveSelection; onFocus?: (key: string | null) => void;
}) {
  const { ov } = useApp();
  const all = ov.plan.moves.filter((mv) => filter === "ALL" || mv.medicine === filter);
  const moves = limit ? all.slice(0, limit) : all;
  if (all.length === 0) return <Empty icon={<Share2 size={26} />}>No transfers left to send{ov.kpis.moves ? " for this medicine" : ": the plan is empty or already sent to the hospitals"}.</Empty>;
  return (
    <div className="space-y-2.5">
      {moves.map((mv, i) => {
        const on = select?.picked.has(mv.key) ?? false;
        return (
          <div key={mv.key} onMouseEnter={() => onFocus?.(mv.key)} onMouseLeave={() => onFocus?.(null)}
            className={`rise rounded-xl border p-3 transition-colors ${on ? "border-brand bg-brand-soft/50" : "border-line hover:border-slate-300"}`} style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex flex-wrap items-center gap-2">
              {select && (
                <input type="checkbox" checked={on} onChange={() => select.toggle(mv.key)} disabled={!select.canSend}
                  className="size-4 accent-[var(--color-brand)]" aria-label={`Select ${mv.from} to ${mv.to}`} />
              )}
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold">
                {mv.from}<ArrowRight size={13} className={mv.kind === "need" ? "text-brand" : mv.kind === "emergency" ? "text-orange-600" : "text-rescue"} />{mv.to}
              </span>
              <Pill tone={mv.kind === "need" ? "brand" : mv.kind === "emergency" ? "amber" : "teal"}>{mv.kind === "need" ? "shortage" : mv.kind === "emergency" ? "emergency loan" : "expiry rescue"}</Pill>
              <span className="num ml-auto text-sm font-bold">{fmt(mv.qty)} {mv.unit}</span>
              {select && (
                <Button size="sm" icon={<Send size={13} />} disabled={!select.canSend || select.busy}
                  title={select.canSend ? `Send only ${mv.from} → ${mv.to} to the donor for approval` : "Switch to Network admin to send"}
                  onClick={() => select.send([mv.key])}>Send</Button>
              )}
            </div>
            <p className="mt-1.5 text-sm font-medium">{mv.text}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted">{mv.reason}</p>
            <p className="mt-1 text-[11px] text-muted">
              {mv.km} km · {mv.hours} h · batches {mv.allocations.map((a) => `${a.batch_id} ×${fmt(a.qty)} (exp ${a.expires_in_days} d)`).join(", ")} · covers ~{mv.covers_days} d at {mv.to}
              {mv.rescued_from_expiry > 0 && ` · rescues ${fmt(mv.rescued_from_expiry)} from expiry`}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default function RedistributionPage() {
  const { ov, meta, actor, act, scenario, weights, names } = useApp();
  const [filter, setFilter] = useState("ALL");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const moves = ov.plan.moves.filter((mv) => filter === "ALL" || mv.medicine === filter);
  const canSend = actor === "NET";
  const gaps = ov.plan.shortfalls.filter((g) => filter === "ALL" || g.medicine === filter);

  // drop selections whose transfer is no longer in the plan (already sent, or the plan changed)
  useEffect(() => {
    const live = new Set(ov.plan.moves.map((m) => m.key));
    setPicked((p) => (p.size && [...p].some((k) => !live.has(k)) ? new Set([...p].filter((k) => live.has(k))) : p));
  }, [ov]);

  const toggle = (key: string) => setPicked((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const send = async (keys: string[]) => {
    if (!keys.length) return;
    setBusy(true);
    const label = (r: { transfer_ids: number[] }) => {
      const first = ov.plan.moves.find((m) => m.key === keys[0]);
      return keys.length === 1 && first
        ? `Sent ${first.from} → ${first.to} (${fmt(first.qty)} ${first.unit}) to ${names.hn(first.from)} for approval. The arrow leaves the map.`
        : `${r.transfer_ids.length} selected transfers sent to their donor hospitals for approval.`;
    };
    await act(() => post("/exchange/send-plan", { scenario, weights, move_ids: keys }), label);
    setPicked(new Set());
    setBusy(false);
  };
  const selection: MoveSelection = { picked, toggle, send, canSend, busy };
  const allKeys = moves.map((m) => m.key);

  return (
    <div className="space-y-5">
      <Card title="Redistribution engine" icon={<Share2 size={18} />}
        subtitle="MILP (HiGHS) per medicine: respects stock limits, donor reserve, expiry before use, transport time and supplier lead time."
        actions={<>
          <Select value={filter} onChange={setFilter}>
            <option value="ALL">All medicines</option>
            {meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Button variant="ghost" size="sm" disabled={!canSend || !moves.length}
            onClick={() => setPicked(picked.size === allKeys.length ? new Set() : new Set(allKeys))}>{picked.size === allKeys.length && allKeys.length ? "Clear" : "Select all"}</Button>
          <Button icon={<Send size={15} />} disabled={!canSend || picked.size === 0 || busy}
            title={canSend ? "" : "Switch to Network admin to send transfers"}
            onClick={() => send([...picked])}>
            Send selected{picked.size ? ` (${picked.size})` : ""}
          </Button>
        </>}>
        {!canSend && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">Only the network admin proposes transfers. Switch “Acting as” to Network admin to send. Donor hospitals approve them in the Hospital Exchange.</p>}
        <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
          <NetworkMap meta={meta} ov={ov} moves={moves} filterMed={filter} focusKey={focus} onHospital={(h) => go(`/hospitals/${h}`)} />
          <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1 scroll-thin">
            <MoveCards filter={filter} select={selection} onFocus={setFocus} />
            {gaps.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5">
                <h3 className="text-sm font-semibold text-amber-900">Still short after transfers</h3>
                <p className="mb-2 text-xs text-amber-900/70">No more stock can be moved safely. Close the gap with a supplier order{ov.plan.moves.some((m) => m.kind === "emergency") ? " (emergency loans above are already counted)" : ""}.</p>
                <ul className="space-y-2">
                  {gaps.map((g) => {
                    const order = ov.orders.find((o) => o.hospital === g.hospital && o.medicine === g.medicine);
                    return (
                      <li key={g.hospital + g.medicine} className="rounded-lg bg-white/80 p-2.5 text-xs leading-5">
                        <b>{names.hn(g.hospital)}</b> · {names.mn(g.medicine)}: needs <b className="num">{fmt(g.need)}</b>, covered <b className="num">{fmt(g.received)}</b>, gap <b className="num text-red-600">{fmt(g.shortfall)}</b>
                        {order && <div className="text-slate-700">🚚 {order.text}</div>}
                        {g.alternative && g.alternative_spare_days >= 3 && <div className="text-slate-700">↔ Substitute: {g.alternative} (about {fmt(g.alternative_spare_days)} spare days on hand)</div>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted">{moves.length} proposed transfer{moves.length === 1 ? "" : "s"}. Hover a card to highlight its arrow. A sent transfer leaves this list and the map; track it in the Hospital Exchange.</p>
      </Card>

    </div>
  );
}
