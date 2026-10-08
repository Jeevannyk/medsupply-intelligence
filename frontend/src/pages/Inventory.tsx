import { Boxes, Layers } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell as RCell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Cell } from "../api";
import { AXIS, C, ChartTooltip, GRID } from "../components/charts";
import { Card, RISK, Select, fmt } from "../components/ui";
import { useApp } from "../context";
import { go } from "../router";

export function InventoryGrid({ compact = false }: { compact?: boolean }) {
  const { ov, meta, setMed, setHosp } = useApp();
  const meds = meta.medicines.map((m) => m.id);
  const at = Object.fromEntries(ov.cells.map((c) => [`${c.hospital}|${c.medicine}`, c]));
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full border-separate border-spacing-y-1.5 text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold tracking-wide text-muted uppercase">
            <th className="pr-3 pb-1">Hospital</th>
            {meds.map((x) => <th key={x} className="px-1 pb-1 text-center">{x}</th>)}
          </tr>
        </thead>
        <tbody>
          {meta.hospitals.map((h) => (
            <tr key={h.id}>
              <td className="pr-3">
                <button className="flex items-center gap-2 text-left font-medium hover:text-brand" onClick={() => go(`/hospitals/${h.id}`)}>
                  <span className="grid size-6 place-items-center rounded-md bg-slate-100 text-[11px] font-bold">{h.id}</span>
                  <span className={compact ? "max-w-28 truncate" : ""}>{h.name}</span>
                </button>
              </td>
              {meds.map((x) => {
                const c = at[`${h.id}|${x}`] as Cell;
                return (
                  <td key={x} className="px-0.5">
                    <button onClick={() => { setMed(x); setHosp(h.id); go("/demand"); }} title={`${c.message}\nOn hand: ${fmt(c.physical)}${c.incoming ? ` · incoming ${fmt(c.incoming)}` : ""}${c.outgoing ? ` · committed out ${fmt(c.outgoing)}` : ""}`}
                      className="num w-full rounded-lg px-1.5 py-1.5 text-center leading-tight transition-transform hover:scale-105"
                      style={{ background: RISK[c.risk].soft, boxShadow: c.risk === "ok" ? "inset 0 0 0 1px #d1fae5" : `inset 0 0 0 1.5px ${RISK[c.risk].color}` }}>
                      <div className="font-semibold">{fmt(c.physical)}</div>
                      <div className="text-[10px] text-muted">{c.days_of_cover ?? "–"} d{c.incoming ? ` · +${fmt(c.incoming)}` : ""}{c.outgoing ? ` · −${fmt(c.outgoing)}` : ""}</div>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RiskLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] font-medium text-muted">
      {(["ok", "watch", "high", "critical", "stockout"] as const).map((r) => (
        <span key={r} className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm" style={{ background: RISK[r].color }} />{RISK[r].label}</span>
      ))}
    </div>
  );
}

export default function InventoryPage() {
  const { ov, meta, med, setMed, names } = useApp();
  const cells = ov.cells.filter((c) => c.medicine === med);
  const data = cells.map((c) => ({ id: c.hospital, cover: c.days_of_cover ?? 0, lead: c.lead_days, risk: c.risk }));
  const totals = meta.medicines.map((m) => {
    const cs = ov.cells.filter((c) => c.medicine === m.id);
    return { m, stock: cs.reduce((s, c) => s + c.physical, 0), incoming: cs.reduce((s, c) => s + c.incoming, 0), daily: cs.reduce((s, c) => s + c.daily_forecast, 0), atRisk: cs.filter((c) => c.risk !== "ok").length };
  });
  return (
    <div className="space-y-5">
      <Card title="Network inventory" icon={<Boxes size={18} />} subtitle="Units physically on hand · days of cover · +incoming / −committed out. On-hand changes when a hospital confirms receipt. Colour = shortage risk. Click a cell to forecast it, a hospital to open its page."
        actions={<RiskLegend />}>
        <InventoryGrid />
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Days of cover vs supplier lead time" icon={<Layers size={18} />}
          subtitle="A hospital whose cover is shorter than its lead time cannot be resupplied in time."
          actions={<Select value={med} onChange={setMed}>{meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}>
          <div className="h-72">
            <ResponsiveContainer>
              <BarChart data={data} margin={{ left: -12, right: 8, top: 8 }} barGap={4}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="id" tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} unit=" d" />
                <Tooltip content={<ChartTooltip suffix=" d" />} cursor={{ fill: "#eef1fb" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="cover" name="Days of cover" radius={[8, 8, 0, 0]} animationDuration={900}>
                  {data.map((d) => <RCell key={d.id} fill={RISK[d.risk].color} />)}
                </Bar>
                <Bar dataKey="lead" name="Supplier lead time" fill={C.slate} radius={[8, 8, 0, 0]} animationDuration={900} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Network stock by medicine" subtitle="Totals across all 8 hospitals">
          <ul className="space-y-3">
            {totals.map(({ m, stock, incoming, daily, atRisk }) => (
              <li key={m.id} className="rounded-xl border border-line p-3">
                <div className="flex items-center justify-between text-sm">
                  <b>{m.name}</b>
                  <span className={`text-[11px] font-semibold ${atRisk ? "text-red-600" : "text-emerald-600"}`}>{atRisk ? `${atRisk} at risk` : "all clear"}</span>
                </div>
                <div className="num mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
                  <span><b className="text-ink">{fmt(stock)}</b> {names.unit(m.id)}</span>
                  {incoming > 0 && <span>+{fmt(incoming)} incoming</span>}
                  <span>{fmt(daily)}/day forecast</span>
                  <span>≈ {fmt(stock / Math.max(daily, 1), 1)} d network cover</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
