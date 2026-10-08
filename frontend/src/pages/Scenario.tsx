import { FlaskConical, Layers, ShieldCheck, Warehouse } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, useApi, type Judge } from "../api";
import { AXIS, C, ChartTooltip, GRID } from "../components/charts";
import { Card, Loading, Pill, RiskBadge, Stat, fmt } from "../components/ui";
import { useApp } from "../context";

export default function ScenarioPage() {
  const { scenario, version, names } = useApp();
  const j = useApi(() => get<Judge>("/judge", { scenario }), [scenario, version]);
  const d = j.data;
  let run = 0;
  const weeks = d?.weekly_demand.map((x, i) => ({ week: `Week ${i + 1}`, demand: x, cumulative: (run += x) })) ?? [];
  return (
    <div className="space-y-5">
      {!d ? <Loading h="h-96" /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Network stock" value={fmt(d.stock_total)} icon={<Warehouse size={16} />} sub={`${names.mn("OSEL")}, whole network`} />
            <Stat label="Weekly demand" value={`${fmt(d.weekly_demand[0])} → ${fmt(d.weekly_demand[d.weekly_demand.length - 1])}`} icon={<Layers size={16} />} tone="amber" sub="last 5 weeks" delay={60} />
            <Stat label="Aggregate cover" value={`${d.aggregate_cover_days} d`} icon={<FlaskConical size={16} />} tone="teal" sub="if all stock were well placed" delay={120} />
            <Stat label="Forecast 14 d" value={fmt(d.forecast_14d.p50)} icon={<ShieldCheck size={16} />} tone="green" sub={`range ${fmt(d.forecast_14d.p10)}–${fmt(d.forecast_14d.p90)}`} delay={180} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
            <Card title="Demand ramp vs stock" icon={<FlaskConical size={18} />} subtitle={d.statement}>
              <div className="h-72">
                <ResponsiveContainer>
                  <ComposedChart data={weeks} margin={{ left: -4, right: 12, top: 12 }}>
                    <defs><linearGradient id="gW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5a76ee" /><stop offset="1" stopColor="#3b5bdb" /></linearGradient></defs>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="week" tick={AXIS} tickLine={false} axisLine={false} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: "#eef1fb" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <ReferenceLine y={d.stock_total} stroke={C.red} strokeDasharray="5 4" label={{ value: `Stock ${fmt(d.stock_total)}`, fontSize: 11, fill: C.red, position: "insideTopLeft" }} />
                    <Bar dataKey="demand" name="Weekly demand" fill="url(#gW)" radius={[8, 8, 0, 0]} barSize={46} animationDuration={900} />
                    <Line dataKey="cumulative" name="Cumulative demand" type="monotone" stroke={C.orange} strokeWidth={3} dot={{ r: 4, fill: "#fff", stroke: C.orange, strokeWidth: 2 }} animationDuration={1100} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title="Ledger" subtitle="Per hospital, before and after the plan" flush>
              <div className="overflow-x-auto px-5 pb-5">
                <table className="num w-full text-xs">
                  <thead><tr className="text-left text-muted"><th className="py-2">Hosp</th><th>Stock</th><th>Runs out</th><th>Lead</th><th>Risk</th><th>Move</th><th>After</th></tr></thead>
                  <tbody>
                    {d.hospitals.slice().sort((a, b) => a.hospital.localeCompare(b.hospital)).map((c) => {
                      const l = d.ledger.find((r) => r.hospital === c.hospital);
                      return (
                        <tr key={c.hospital} className="border-t border-line">
                          <td className="py-1.5 font-semibold">{c.hospital}</td><td>{fmt(c.stock)}</td><td>{c.days_to_stockout ?? "60+"} d</td><td>{c.lead_days} d</td>
                          <td><RiskBadge risk={c.risk} /></td>
                          <td className={l?.out ? "text-red-600" : "text-emerald-600"}>{l ? (l.out ? `−${fmt(l.out)}` : l.in ? `+${fmt(l.in)}` : "") : ""}</td>
                          <td className="font-bold">{l ? fmt(l.after) : fmt(c.stock)}</td>
                        </tr>
                      );
                    })}
                    <tr className="border-t-2 border-ink font-bold"><td className="py-2">Total</td><td>{fmt(d.totals.before)}</td><td colSpan={4}>moved {fmt(d.totals.moved)}</td><td>{fmt(d.totals.after)}</td></tr>
                  </tbody>
                </table>
                <div className="mt-3"><Pill tone={d.passed ? "green" : "red"}>{d.passed ? "✓" : "✗"} {d.checks.filter((c) => c.passed).length}/{d.checks.length} verification checks passed</Pill></div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
