import { CalendarClock, PackageX, Radio, Wallet } from "lucide-react";
import { post } from "../api";
import { Button, Card, Empty, Stat, fmt, inr } from "../components/ui";
import { useApp } from "../context";
import { Link } from "../router";

export function ExpiryList({ limit }: { limit?: number }) {
  const { ov, names, actor, scenario, act } = useApp();
  const list = limit ? ov.expiry.slice(0, limit) : ov.expiry;
  if (ov.expiry.length === 0) return <Empty icon={<PackageX size={26} />}>No stock projected to expire unused.</Empty>;
  return (
    <ul className="space-y-2.5">
      {list.map((e, i) => {
        const usedPct = Math.min(100, (e.expected_use / e.qty) * 100), wastePct = Math.min(100 - usedPct, (e.projected_waste / e.qty) * 100);
        const allowed = actor === e.hospital;   // hospitals post offers, never the network admin
        return (
          <li key={e.batch_id} className="rise rounded-xl border border-line p-3.5 transition-colors hover:border-slate-300" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Link to={`/hospitals/${e.hospital}`} className="font-semibold hover:text-brand">{names.hn(e.hospital)}</Link>
              <span className="text-muted">· {names.mn(e.medicine)}</span>
              <span className="num ml-auto text-sm font-bold text-red-600">{fmt(e.projected_waste)} wasted · {inr(e.value)}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted">Batch {e.batch_id} · expires {e.expiry_date} ({e.days_left} d)</p>
            <div className="my-2.5 flex h-3 overflow-hidden rounded-full bg-slate-100" title="green = used before expiry, red = wasted">
              <div className="bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-700" style={{ width: `${usedPct}%` }} />
              <div className="bg-gradient-to-r from-red-400 to-red-500 transition-all duration-700" style={{ width: `${wastePct}%` }} />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted"><span>■ used {fmt(e.expected_use)}</span><span className="text-red-500">■ wasted {fmt(e.projected_waste)}</span></div>
            <p className="mt-2 text-xs leading-5 text-slate-600">{e.reason}</p>
            <div className="mt-2.5">
              <Button size="sm" variant="subtle" icon={<Radio size={14} />} disabled={e.virtual || !allowed}
                title={allowed ? "" : `Switch “Acting as” to ${e.hospital} to broadcast this offer`}
                onClick={() => act(() => post("/offers", {
                  hospital: e.hospital, medicine: e.medicine, qty: e.projected_waste, batch_id: e.batch_id,
                  note: `Expires in ${e.days_left} days.`, scenario,
                }), (r: { offer_id: number; suggested_takers: { hospital: string; can_use: number }[] }) =>
                  `Offer #${r.offer_id} broadcast. AI-matched takers: ${r.suggested_takers.map((t) => `${t.hospital} (${fmt(t.can_use)})`).join(", ") || "none"}`)}>
                Broadcast surplus offer
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function ExpiryPage() {
  const { ov } = useApp();
  const waste = ov.expiry.reduce((s, e) => s + e.projected_waste, 0);
  const value = ov.expiry.reduce((s, e) => s + e.value, 0);
  const soon = ov.expiry.filter((e) => e.days_left <= 30).length;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Batches at risk" value={ov.expiry.length} icon={<PackageX size={16} />} tone="amber" sub="projected to expire unused" />
        <Stat label="Units wasted" value={fmt(waste)} icon={<CalendarClock size={16} />} tone="red" sub={`${soon} batches expire within 30 days`} delay={60} />
        <Stat label="Value at risk" value={inr(value)} icon={<Wallet size={16} />} tone="red" sub="at unit cost" delay={120} />
      </div>
      <Card title="Expiry & wastage risk" icon={<PackageX size={18} />}
        subtitle="Stock vs expected demand before expiry (first-expiry-first-out). Broadcast surplus so other hospitals can claim it before it is lost.">
        <ExpiryList />
      </Card>
    </div>
  );
}
