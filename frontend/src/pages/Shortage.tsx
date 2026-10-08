import { ArrowRight, ShieldCheck, Siren, Truck } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell as RCell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Cell } from "../api";
import { AXIS, C, ChartTooltip, GRID } from "../components/charts";
import { Button, Card, Empty, RISK, RiskBadge, fmt } from "../components/ui";
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
  const { ov, names } = useApp();
  const data = ov.warnings.map((c) => ({ id: `${c.hospital} · ${c.medicine}`, runway: c.days_to_stockout ?? 60, lead: c.lead_days, risk: c.risk }));
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
        <Card title="Shortage warnings" icon={<Siren size={18} />}
          subtitle="Days until stock-out against supplier lead time. The dark tick is when a resupply order would arrive."
          actions={<Button size="sm" variant="secondary" icon={<ArrowRight size={14} />} onClick={() => go("/redistribution")}>Open redistribution plan</Button>}>
          <ShortageList />
        </Card>
        <Card title="Runway vs lead time" subtitle="Where the red bar is shorter than the grey one, an order placed today arrives too late.">
          {data.length === 0 ? <Empty>Nothing to chart.</Empty> : (
            <div style={{ height: Math.max(220, data.length * 46) }}>
              <ResponsiveContainer>
                <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4 }} barGap={3}>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} unit=" d" />
                  <YAxis type="category" dataKey="id" tick={AXIS} tickLine={false} axisLine={false} width={86} />
                  <Tooltip content={<ChartTooltip suffix=" d" />} cursor={{ fill: "#eef1fb" }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="runway" name="Days to stock-out" radius={[0, 8, 8, 0]} animationDuration={900}>
                    {data.map((d) => <RCell key={d.id} fill={RISK[d.risk].color} />)}
                  </Bar>
                  <Bar dataKey="lead" name="Supplier lead time" fill={C.slate} radius={[0, 8, 8, 0]} animationDuration={900} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card title="Supplier orders to place today" icon={<Truck size={18} />} subtitle="Recommended order quantity so that stock lasts until the next resupply plus buffer.">
        {ov.orders.length === 0 ? <Empty>No orders needed.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {ov.orders.map((o) => (
              <div key={o.hospital + o.medicine} className="rounded-xl border border-line bg-slate-50/60 p-3.5">
                <div className="flex items-center justify-between text-sm">
                  <b>{names.hn(o.hospital)}</b>
                  <span className="rounded-md bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand-ink">arrives in {o.arrives_in_days} d</span>
                </div>
                <div className="num mt-1 text-lg font-bold">{fmt(o.qty)} <span className="text-xs font-medium text-muted">{names.unit(o.medicine)} · {names.mn(o.medicine)}</span></div>
                <p className="mt-1 text-xs text-muted">{o.text}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
