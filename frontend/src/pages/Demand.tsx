import { useEffect, useState } from "react";
import { Info, LineChart as LineIcon, Sparkles, X } from "lucide-react";
import { Area, Brush, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, post, useApi, type ForecastAnalysis, type Series } from "../api";
import { AXIS, C, ChartTooltip, GRID } from "../components/charts";
import { Button, Card, Loading, Pill, Select, fmt } from "../components/ui";
import { Markdown } from "./Assistant";
import { useApp } from "../context";

export function DemandPanel({ compact = false }: { compact?: boolean }) {
  const { meta, scenario, med, hosp, setMed, setHosp, version, names } = useApp();
  const s = useApi(() => get<Series>("/forecast", { scenario, medicine: med, hospital: hosp }), [scenario, med, hosp, version]);
  const d = s.data;

  // AI reading of exactly the chart on screen; cleared whenever the medicine, hospital or scenario changes
  type Ai = { for: string; loading: boolean; text?: string; mode?: string; note?: string; err?: string };
  const [ai, setAi] = useState<Ai | null>(null);
  const chartKey = `${scenario}|${med}|${hosp}`;
  useEffect(() => setAi(null), [chartKey]);
  const analyze = async () => {
    const k = chartKey;
    setAi({ for: k, loading: true });
    try {
      const r = await post<ForecastAnalysis>("/analyze/forecast", { scenario, medicine: med, hospital: hosp });
      setAi((cur) => (cur?.for === k ? { for: k, loading: false, text: r.analysis, mode: r.mode, note: r.note } : cur));
    } catch (e) {
      setAi((cur) => (cur?.for === k ? { for: k, loading: false, err: (e as Error).message } : cur));
    }
  };
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
        {!compact && <Button size="sm" variant="subtle" icon={<Sparkles size={14} />} loading={ai?.loading} onClick={analyze}>Analyze with AI</Button>}
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
          {!compact && ai && (
            <div className="rise mb-4 rounded-xl border border-brand/20 bg-gradient-to-br from-brand-soft/70 to-white p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-brand-ink">
                <Sparkles size={14} />AI analysis · {hosp === "ALL" ? "Whole network" : names.hn(hosp)} · {names.mn(med)}
                <span className="ml-auto flex items-center gap-2">
                  {ai.mode && <Pill tone="slate">{ai.mode.startsWith("gemini") ? "Gemini" : "built-in"}</Pill>}
                  <button className="rounded-md p-1 text-muted hover:bg-white hover:text-ink" onClick={() => setAi(null)} aria-label="Dismiss analysis"><X size={14} /></button>
                </span>
              </div>
              {ai.loading ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                  <span className="flex gap-1">{[0, 1, 2].map((i) => <i key={i} className="size-1.5 animate-bounce rounded-full bg-brand" style={{ animationDelay: `${i * 140}ms` }} />)}</span>
                  Reading the chart…
                </div>
              ) : ai.err ? <p className="mt-2 text-sm text-red-700">{ai.err}</p> : (
                <>
                  <div className="mt-2 text-sm text-slate-700"><Markdown text={ai.text ?? ""} /></div>
                  {ai.note && <p className="mt-2 text-[11px] text-muted">{ai.note}</p>}
                </>
              )}
            </div>
          )}
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
      {!compact && <ChartGuide />}
    </Card>
  );
}

const Swatch = ({ children }: { children: React.ReactNode }) => <span className="mt-1.5 inline-flex h-3 w-9 shrink-0 items-center justify-center">{children}</span>;

/** Plain-language key to the chart above (replaces the old accuracy table). */
function ChartGuide() {
  const rows: [React.ReactNode, string, string][] = [
    [<Swatch key="a"><i className="h-0.5 w-full rounded bg-ink" /></Swatch>, "Actual demand", "units the hospital really used each day."],
    [<Swatch key="f"><i className="w-full border-t-[3px] border-dashed" style={{ borderColor: C.brand }} /></Swatch>, "Forecast", "the most likely demand for each of the next 14 days. This is what the stock-out warnings are built on."],
    [<Swatch key="b"><i className="h-3 w-full rounded-sm" style={{ background: C.brand, opacity: 0.25 }} /></Swatch>, "Shaded band", "the likely range (80% interval). A wide band means the forecast is less certain."],
    [<Swatch key="g"><i className="w-full border-t-2 border-dotted" style={{ borderColor: C.slate }} /></Swatch>, "Model only", "what the model predicts on its own, before the outbreak adjustment lifts it."],
    [<Swatch key="r"><i className="size-2.5 rounded-full border border-white" style={{ background: C.red }} /></Swatch>, "Red dots", "days when demand jumped well above normal."],
    [<Swatch key="v"><i className="h-3 w-0 border-l-2 border-dashed" style={{ borderColor: C.orange }} /></Swatch>, "Outbreak starts / Detected", "when demand began to rise, and the day the system flagged it."],
  ];
  return (
    <div className="mt-5 rounded-xl border border-line bg-slate-50/60 px-4 py-3.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink"><Info size={14} className="text-brand" />How to read this chart</h3>
      <ul className="mt-2 grid gap-x-8 gap-y-1.5 text-xs leading-5 text-slate-600 md:grid-cols-2">
        {rows.map(([sw, name, text]) => (
          <li key={name} className="flex gap-2.5">{sw}<span><b className="font-semibold text-ink">{name}</b> · {text}</span></li>
        ))}
      </ul>
      <p className="mt-2.5 text-xs leading-5 text-muted">
        Everything right of the <b className="text-slate-700">Today</b> line is a prediction. Drag the handles on the slider under the chart to zoom into any stretch,
        and use the dropdowns above to switch medicine or hospital.
      </p>
    </div>
  );
}

export default function DemandPage() {
  return <DemandPanel />;
}
