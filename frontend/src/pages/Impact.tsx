import { useState } from "react";
import { BarChart3, Gauge, PackageX, TrendingDown } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, useApi, weightParams, type Outcome, type Scenario } from "../api";
import { AXIS, C, ChartTooltip, GRID } from "../components/charts";
import { Card, Loading, Segmented, Stat, fmt } from "../components/ui";
import { useApp } from "../context";

const delta = (a: number, b: number) => (a ? `${Math.round((100 * (b - a)) / a)}%` : "–");

export default function ImpactPage() {
  const { weights, version } = useApp();
  const [view, setView] = useState<Scenario>("outbreak");
  const cmp = useApi(() => get<Record<Scenario, Outcome>>("/compare", weightParams(weights)), [JSON.stringify(weights), version]);
  const o = cmp.data?.[view];
  const rows: [string, keyof Outcome["with"]][] = [
    ["Hospital-medicine pairs that stock out", "stockout_cells"], ["Stock-out days", "stockout_days"],
    ["Unmet patient doses", "unmet_units"], ["…of which life-saving medicines", "unmet_critical"], ["Units expiring unused (projected)", "waste"],
  ];
  let cw = 0, cs = 0;
  const cumulative = o?.daily.map((d) => ({ date: d.date.slice(5), without: (cw += d.without), with: (cs += d.with) })) ?? [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Simulated over the next 14 days on hidden ground-truth demand.</p>
        <Segmented value={view} onChange={setView} options={[{ value: "normal", label: "Before outbreak" }, { value: "outbreak", label: "After outbreak" }]} />
      </div>
      {!o ? <Loading h="h-96" /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Stock-out days" value={`${fmt(o.without.stockout_days)} → ${fmt(o.with.stockout_days)}`} icon={<Gauge size={16} />} tone="green" sub={`${delta(o.without.stockout_days, o.with.stockout_days)} with system`} />
            <Stat label="Unmet doses" value={`${fmt(o.without.unmet_units)} → ${fmt(o.with.unmet_units)}`} icon={<TrendingDown size={16} />} tone="green" sub={`${delta(o.without.unmet_units, o.with.unmet_units)} with system`} delay={60} />
            <Stat label="Life-saving unmet" value={`${fmt(o.without.unmet_critical)} → ${fmt(o.with.unmet_critical)}`} icon={<BarChart3 size={16} />} tone="brand" sub={`${delta(o.without.unmet_critical, o.with.unmet_critical)} with system`} delay={120} />
            <Stat label="Waste (units)" value={`${fmt(o.without.waste)} → ${fmt(o.with.waste)}`} icon={<PackageX size={16} />} tone="amber" sub={`${delta(o.without.waste, o.with.waste)} with system`} delay={180} />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Daily unmet doses" subtitle="Without the system (red) versus with it (blue)">
              <div className="h-72">
                <ResponsiveContainer>
                  <BarChart data={o.daily.map((d) => ({ ...d, date: d.date.slice(5) }))} margin={{ left: -8, right: 8, top: 8 }} barGap={2}>
                    <defs>
                      <linearGradient id="gWithout" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f87171" /><stop offset="1" stopColor="#fecaca" /></linearGradient>
                      <linearGradient id="gWith" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5a76ee" /><stop offset="1" stopColor="#3b5bdb" /></linearGradient>
                    </defs>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={false} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: "#eef1fb" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="without" name="Without system" fill="url(#gWithout)" radius={[6, 6, 0, 0]} animationDuration={900} />
                    <Bar dataKey="with" name="With system" fill="url(#gWith)" radius={[6, 6, 0, 0]} animationDuration={900} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Cumulative unmet doses" subtitle="The gap is the patient demand the system covers">
              <div className="h-72">
                <ResponsiveContainer>
                  <AreaChart data={cumulative} margin={{ left: -8, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="gcw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.red} stopOpacity={0.35} /><stop offset="1" stopColor={C.red} stopOpacity={0} /></linearGradient>
                      <linearGradient id="gcs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.brand} stopOpacity={0.4} /><stop offset="1" stopColor={C.brand} stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={false} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="without" name="Without system" stroke={C.red} strokeWidth={2.5} fill="url(#gcw)" animationDuration={1000} />
                    <Area type="monotone" dataKey="with" name="With system" stroke={C.brand} strokeWidth={2.5} fill="url(#gcs)" animationDuration={1000} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card title="Detail" subtitle="Without = no transfers, hospitals reorder only when they run out. With = AI transfers plus proactive orders today." flush>
            <div className="overflow-x-auto px-5 pb-5">
              <table className="num w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-2"></th><th>Without system</th><th>With system</th><th>Change</th></tr></thead>
                <tbody>
                  {rows.map(([l, k]) => (
                    <tr key={k} className="border-t border-line">
                      <td className="py-2 text-xs">{l}</td><td>{fmt(o.without[k])}</td><td className="font-bold">{fmt(o.with[k])}</td>
                      <td className={o.with[k] < o.without[k] ? "font-semibold text-emerald-600" : "text-muted"}>{delta(o.without[k], o.with[k])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
