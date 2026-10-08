import { LineChart as LineIcon } from "lucide-react";
import { Area, Brush, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, useApi, type Series } from "../api";
import { AXIS, C, ChartTooltip, GRID } from "../components/charts";
import { Card, Loading, Pill, Select, fmt } from "../components/ui";
import { useApp } from "../context";

export function DemandPanel({ compact = false }: { compact?: boolean }) {
  const { meta, scenario, med, hosp, setMed, setHosp, version } = useApp();
  const s = useApi(() => get<Series>("/forecast", { scenario, medicine: med, hospital: hosp }), [scenario, med, hosp, version]);
  const d = s.data;
  const data = d ? [
    ...d.history.map((p) => ({ date: p.date.slice(5), actual: p.actual, anomaly: p.anomaly ? p.actual : null })),
    ...d.forecast.map((p) => ({ date: p.date.slice(5), p50: p.p50, band: [p.p10, p.p90], gbm: p.gbm })),
  ] : [];
  const dates = new Set(data.map((x) => x.date));
  const today = d?.forecast[0]?.date.slice(5);
  const last = data[data.length - 1]?.date;
  const outbreak = d && dates.has(d.outbreak_start.slice(5)) ? d.outbreak_start.slice(5) : null;
  const detected = d?.detected_date && dates.has(d.detected_date.slice(5)) ? d.detected_date.slice(5) : null;
  const h = compact ? "h-64" : "h-96";
  return (
    <Card title="Predicted demand · next 14 days" icon={<LineIcon size={18} />}
      subtitle="Gradient boosting with outbreak adjustment · band = 80% interval · red dots = anomaly days"
      actions={<>
        <Select value={med} onChange={setMed}>{meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select value={hosp} onChange={setHosp}>
          <option value="ALL">Whole network</option>
          {meta.hospitals.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.name}</option>)}
        </Select>
      </>}>
      {!d ? <Loading h={h} /> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Pill tone="brand">Next 7 d · {fmt(d.next_7d)}</Pill>
            <Pill tone="brand">Next 14 d · {fmt(d.next_14d)}</Pill>
            {d.spike
              ? <Pill tone="red">Spike detected {d.detected_date} · outbreak began {d.outbreak_start}</Pill>
              : <Pill tone="green">No spike detected</Pill>}
          </div>
          <div className={h}>
            <ResponsiveContainer>
              <ComposedChart data={data} margin={{ left: -8, right: 12, top: 18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gActual" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.ink} stopOpacity={0.18} /><stop offset="1" stopColor={C.ink} stopOpacity={0} /></linearGradient>
                  <linearGradient id="gBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.brand} stopOpacity={0.35} /><stop offset="1" stopColor={C.brand} stopOpacity={0.08} /></linearGradient>
                </defs>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={false} interval={compact ? 9 : 6} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: C.brand, strokeDasharray: "3 3" }} />
                {today && last && <ReferenceArea x1={today} x2={last} fill={C.brand} fillOpacity={0.05} />}
                {outbreak && <ReferenceLine x={outbreak} stroke={C.orange} strokeDasharray="4 4" label={{ value: "Outbreak starts", fontSize: 10, fill: C.orange, position: "insideTopLeft", dy: 2 }} />}
                {detected && <ReferenceLine x={detected} stroke={C.red} strokeDasharray="4 4" label={{ value: "Detected", fontSize: 10, fill: C.red, position: "insideTopLeft", dy: 18 }} />}
                {today && <ReferenceLine x={today} stroke="#475569" label={{ value: "Today", fontSize: 10, fill: "#475569", position: "top" }} />}
                <Area dataKey="band" name="P10–P90" stroke="none" fill="url(#gBand)" animationDuration={900} />
                <Area dataKey="actual" name="Actual" type="monotone" stroke={C.ink} strokeWidth={2} fill="url(#gActual)" dot={false}
                  activeDot={{ r: 4 }} animationDuration={900} />
                <Line dataKey="anomaly" name="Anomaly" legendType="none" stroke="none" dot={{ r: 3.5, fill: C.red, stroke: "#fff", strokeWidth: 1.5 }} activeDot={false} animationDuration={900} />
                <Line dataKey="gbm" name="Model only" type="monotone" stroke={C.slate} strokeDasharray="2 4" strokeWidth={1.8} dot={false} animationDuration={900} />
                <Line dataKey="p50" name="Forecast (P50)" type="monotone" stroke={C.brand} strokeWidth={3} strokeDasharray="7 4" dot={false}
                  activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }} animationDuration={1100} />
                {!compact && <Brush dataKey="date" height={26} stroke={C.brand} fill="#f8faff" travellerWidth={10} startIndex={Math.max(0, data.length - 60)} />}
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {!compact && (
            <p className="mt-2 text-xs text-muted">Weekly demand ({hosp === "ALL" ? "network" : hosp}):{" "}
              {d.weekly.slice(-6).map((x) => <span key={x.week_ending} className="num mr-3 font-semibold text-ink">{fmt(x.units)}</span>)}
            </p>
          )}
        </>
      )}
      {!compact && <Backtest />}
    </Card>
  );
}

function Backtest() {
  const { ov, med } = useApp();
  const metrics = ov.metrics.network_by_medicine[med];
  return (
    <div className="mt-5 overflow-x-auto scroll-thin rounded-xl border border-line">
      <table className="num w-full text-xs">
        <caption className="bg-slate-50 px-3 py-2 text-left text-muted">
          Backtest · last {ov.metrics.holdout_days} days held out · {med} at network level, plus all 48 series
        </caption>
        <thead><tr className="text-left text-muted"><th className="px-3 py-2">Method</th><th>{med} WAPE</th><th>{med} MAPE</th><th>All-series MAE</th><th>All-series WAPE</th><th>Spike-series WAPE</th></tr></thead>
        <tbody>
          {Object.keys(ov.metrics.overall).map((k) => (
            <tr key={k} className="border-t border-line">
              <td className="px-3 py-2 font-medium capitalize">{k.replaceAll("_", " ")}</td>
              <td>{fmt(metrics?.[k]?.wape, 1)}%</td><td>{fmt(metrics?.[k]?.mape, 1)}%</td>
              <td>{fmt(ov.metrics.overall[k].mae, 1)}</td><td>{fmt(ov.metrics.overall[k].wape, 1)}%</td>
              <td>{ov.metrics.spike_series[k] ? `${fmt(ov.metrics.spike_series[k].wape, 1)}%` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DemandPage() {
  return <DemandPanel />;
}
