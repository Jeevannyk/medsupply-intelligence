import { useState } from "react";
import { Scale, SlidersHorizontal } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Weights } from "../api";
import { AXIS, ChartTooltip, GRID } from "../components/charts";
import { Button, Card, Select, fmt } from "../components/ui";
import { useApp } from "../context";
import { Link } from "../router";

export const FACTOR_COLORS: Record<string, string> = {
  patient_load: "#3b5bdb", emergency: "#dc2626", criticality: "#7c3aed", no_alternative: "#ca8a04", urgency: "#ea580c",
};
export const FACTOR_LABELS: Record<string, string> = {
  patient_load: "Patient load", emergency: "Emergency demand", criticality: "Criticality", no_alternative: "No alternative", urgency: "Urgency",
};

export default function PriorityPage() {
  const { ov, meta, names, med, setMed, weights, setWeights } = useApp();
  const [draft, setDraft] = useState<Weights>(weights);
  const cells = ov.cells.filter((c) => c.medicine === med).sort((a, b) => b.priority.score - a.priority.score);
  const need = cells.reduce((s, c) => s + c.need, 0), spare = cells.reduce((s, c) => s + c.surplus, 0);
  const got = (h: string) => ov.plan.moves.filter((mv) => mv.medicine === med && mv.to === h).reduce((s, mv) => s + mv.qty, 0);
  const data = cells.map((c) => ({ id: c.hospital, ...c.priority.contributions }));
  const sum = Object.keys(FACTOR_LABELS).reduce((s, k) => s + (draft[k] ?? 0), 0);
  return (
    <div className="space-y-5">
      <Card title="Priority facilities" icon={<Scale size={18} />}
        subtitle="Transparent score = weighted sum of five factors (0–100). The optimiser uses it when hospitals compete for scarce stock."
        actions={<Select value={med} onChange={setMed}>{meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}>
        <p className={`mb-4 rounded-xl px-3 py-2 text-xs ${need > spare ? "bg-red-50 font-semibold text-red-700" : "bg-slate-50 text-muted"}`}>
          {need > spare
            ? `Scarce: hospitals need ${fmt(need)} ${names.unit(med)} before resupply, but network spare is only ${fmt(spare)}.`
            : `Need before resupply ${fmt(need)} vs network spare ${fmt(spare)}.`}
        </p>
        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <div>
            <div style={{ height: Math.max(260, cells.length * 44) }}>
              <ResponsiveContainer>
                <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 4 }} barCategoryGap={10}>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="id" tick={{ ...AXIS, fontWeight: 700 }} tickLine={false} axisLine={false} width={28} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "#eef1fb" }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v: string) => FACTOR_LABELS[v] ?? v} />
                  {Object.keys(FACTOR_LABELS).map((k, i, a) => (
                    <Bar key={k} dataKey={k} name={FACTOR_LABELS[k]} stackId="s" fill={FACTOR_COLORS[k]} animationDuration={900}
                      radius={i === a.length - 1 ? [0, 8, 8, 0] : 0} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ol className="mt-4 space-y-2">
              {cells.map((c, i) => (
                <li key={c.hospital} className="flex gap-3 rounded-xl border border-line p-3">
                  <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold ${i === 0 ? "bg-brand text-white" : "bg-slate-100"}`}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Link to={`/hospitals/${c.hospital}`} className="font-semibold hover:text-brand">{names.hn(c.hospital)}</Link>
                      <span className="num ml-auto font-bold">{c.priority.score}</span>
                    </div>
                    {c.need > 0 && <p className="num text-[11px] text-muted">needs {fmt(c.need)} · gets {fmt(got(c.hospital))}</p>}
                    <p className="mt-0.5 text-xs leading-5 text-slate-600">{c.priority.explanation}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="h-fit rounded-2xl border border-line bg-gradient-to-b from-slate-50 to-white p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal size={16} className="text-brand" />Tune weights</h3>
            {Object.keys(FACTOR_LABELS).map((k) => (
              <label key={k} className="mb-3 block text-xs font-medium">
                <span className="flex items-center gap-2"><i className="size-2.5 rounded-sm" style={{ background: FACTOR_COLORS[k] }} />{FACTOR_LABELS[k]}
                  <span className="num ml-auto rounded bg-white px-1.5 py-0.5 font-bold shadow-sm ring-1 ring-black/5">{(draft[k] ?? 0).toFixed(2)}</span></span>
                <input type="range" min={0} max={1} step={0.05} value={draft[k] ?? 0} className="mt-1.5 w-full"
                  onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} />
              </label>
            ))}
            <p className="mb-3 text-[11px] text-muted">Weights sum to {sum.toFixed(2)} (normalised automatically).</p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setWeights(draft)}>Apply & re-plan</Button>
              <Button variant="secondary" onClick={() => { setDraft(meta.default_weights); setWeights(meta.default_weights); }}>Reset</Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
