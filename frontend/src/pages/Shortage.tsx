import { ArrowRight, ShieldCheck, Siren } from "lucide-react";
import type { Cell } from "../api";
import { Button, Card, Empty, RISK, RiskBadge } from "../components/ui";
import { useApp } from "../context";
import { go, Link } from "../router";

export function ShortageList({ limit }: { limit?: number }) {
  const { ov, names } = useApp();
  const list = limit ? ov.warnings.slice(0, limit) : ov.warnings;
  if (ov.warnings.length === 0) return <Empty icon={<ShieldCheck size={26} />}>No shortages predicted.</Empty>;
  return (
    <ul className="space-y-2.5">
      {list.map((c: Cell, i) => {
        const scale = 21;
        const d = Math.min(c.days_to_stockout ?? scale, scale);
        return (
          <li key={c.hospital + c.medicine} className="rise rounded-xl border border-line p-3 transition-colors hover:border-slate-300" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <RiskBadge risk={c.risk} />
              <Link to={`/hospitals/${c.hospital}`} className="font-semibold hover:text-brand">{names.hn(c.hospital)}</Link>
              <span className="text-muted">· {names.mn(c.medicine)}</span>
              <span className="num ml-auto rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold">{c.days_to_stockout ?? "60+"} d left · lead {c.lead_days} d</span>
            </div>
            <div className="relative my-2.5 h-2.5 rounded-full bg-slate-100">
              <div className="h-2.5 rounded-full transition-all duration-700" style={{ width: `${(d / scale) * 100}%`, background: `linear-gradient(90deg, ${RISK[c.risk].color}aa, ${RISK[c.risk].color})` }} />
              <div className="absolute -top-1 h-4.5 w-0.5 rounded bg-ink" style={{ left: `${(Math.min(c.lead_days, scale) / scale) * 100}%` }} title={`Lead time ${c.lead_days} d`} />
            </div>
            <p className="text-xs leading-5 text-slate-600">{c.message}</p>
          </li>
        );
      })}
    </ul>
  );
}

export default function ShortagePage() {
  return (
    <Card title="Shortage warnings" icon={<Siren size={18} />}
      subtitle="Days until stock-out against supplier lead time. The dark tick is when a resupply order would arrive."
      actions={<Button size="sm" variant="secondary" icon={<ArrowRight size={14} />} onClick={() => go("/redistribution")}>Open redistribution plan</Button>}>
      <ShortageList />
    </Card>
  );
}
