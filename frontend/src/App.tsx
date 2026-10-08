import { useState } from "react";
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  get, post, useApi, weightParams,
  type AssistantReply, type Board, type Cell, type Hospital, type HospitalDetail, type Judge, type Meta, type Move,
  type Outcome, type Overview, type Scenario, type Series, type Transfer, type Weights,
} from "./api";
import { Button, Card, Empty, Loading, RISK, RISK_RANK, RiskBadge, Segmented, Select, fmt, inr } from "./components/ui";

type Names = { hn: (id: string) => string; mn: (id: string) => string; unit: (id: string) => string };
type Act = (fn: () => Promise<unknown>, ok: string | ((r: any) => string)) => Promise<void>;

const FACTOR_COLORS: Record<string, string> = {
  patient_load: "#0f766e", emergency: "#dc2626", criticality: "#6366f1", no_alternative: "#ca8a04", urgency: "#ea580c",
};
const FACTOR_LABELS: Record<string, string> = {
  patient_load: "Patient load", emergency: "Emergency demand", criticality: "Criticality",
  no_alternative: "No alternative", urgency: "Urgency",
};

export default function App() {
  const [scenario, setScenario] = useState<Scenario>("outbreak");
  const [actor, setActor] = useState("NET");
  const [med, setMed] = useState("OSEL");
  const [hosp, setHosp] = useState("ALL");
  const [weights, setWeights] = useState<Weights | null>(null);
  const [version, setVersion] = useState(0);
  const [drill, setDrill] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const meta = useApi(() => get<Meta>("/meta"), []);
  const w = weights ?? meta.data?.default_weights ?? {};
  const wKey = JSON.stringify(w);
  const ov = useApi(() => get<Overview>("/overview", { scenario, ...weightParams(w) }), [scenario, wKey, version]);

  if (meta.error) return <p className="p-8 text-red-700">Backend not reachable: {meta.error}. Start it with uvicorn (see README).</p>;
  if (!meta.data) return <div className="p-8"><Loading /></div>;
  const m = meta.data;
  const H = Object.fromEntries(m.hospitals.map((h) => [h.id, h]));
  const M = Object.fromEntries(m.medicines.map((x) => [x.id, x]));
  const names: Names = {
    hn: (id) => (id === "AI" ? "Network AI" : id === "NET" ? "Network admin" : id === "ALL" ? "All hospitals" : H[id]?.name ?? id),
    mn: (id) => M[id]?.name ?? id,
    unit: (id) => M[id]?.unit ?? "units",
  };
  const act: Act = async (fn, ok) => {
    try {
      const r = await fn();
      setToast({ msg: typeof ok === "function" ? ok(r) : ok });
      setVersion((v) => v + 1);
    } catch (e) {
      setToast({ msg: (e as Error).message, error: true });
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="mr-auto">
            <h1 className="text-lg font-bold">MedSupply Intelligence</h1>
            <p className="text-xs text-muted">Know before the shortage · today {m.today} · 8 hospitals · 6 medicines</p>
          </div>
          <Segmented value={scenario} onChange={setScenario}
            options={[{ value: "outbreak", label: "After outbreak (current)" }, { value: "normal", label: "Before / no outbreak" }]} />
          <Select label="Acting as" value={actor} onChange={setActor}>
            <option value="NET">Network admin</option>
            {m.hospitals.map((h) => <option key={h.id} value={h.id}>{h.id} · {h.name}</option>)}
          </Select>
          <Button variant="ghost" size="sm" onClick={() => act(() => post("/reset"), "Demo data regenerated")}>Reset demo</Button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-4 overflow-x-auto px-4 pb-2 text-xs font-medium text-muted">
          {[["inventory", "1 Inventory"], ["demand", "2 Predicted demand"], ["shortage", "3 Shortage risk"], ["expiry", "4 Expiry risk"],
            ["redistribution", "5 Redistribution"], ["priority", "6 Priority"], ["impact", "Impact"], ["judge", "Judge scenario"],
            ["exchange", "Hospital exchange"], ["assistant", "AI assistant"]].map(([id, l]) => (
            <a key={id} href={`#${id}`} className="whitespace-nowrap hover:text-brand">{l}</a>
          ))}
        </nav>
      </header>

      {toast && (
        <div className={`fixed bottom-4 left-1/2 z-50 max-w-xl -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${toast.error ? "bg-red-700" : "bg-ink"}`}
          onClick={() => setToast(null)}>
          {toast.msg} <span className="ml-2 opacity-60">✕</span>
        </div>
      )}

      <main className="mx-auto max-w-7xl space-y-5 px-4 pt-5">
        {ov.error && <p className="text-red-700">Error: {ov.error}</p>}
        {!ov.data ? <Loading /> : (
          <>
            <Kpis ov={ov.data} loading={ov.loading} />
            <div className="grid gap-5 lg:grid-cols-2">
              <Inventory ov={ov.data} hospitals={m.hospitals} meds={m.medicines.map((x) => x.id)}
                onPick={(mm, hh) => { setMed(mm); setHosp(hh); }} onHospital={setDrill} />
              <Demand ov={ov.data} meta={m} scenario={scenario} med={med} hosp={hosp} setMed={setMed} setHosp={setHosp} version={version} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Shortage ov={ov.data} names={names} onHospital={setDrill} />
              <Expiry ov={ov.data} names={names} actor={actor} scenario={scenario} act={act} />
            </div>
            <Redistribution ov={ov.data} meta={m} names={names} med={med} actor={actor} act={act} scenario={scenario} weights={w}
              onHospital={setDrill} />
            <PriorityPanel ov={ov.data} meta={m} names={names} med={med} setMed={setMed} weights={w} setWeights={setWeights} />
            <div className="grid gap-5 lg:grid-cols-2">
              <Impact weights={w} version={version} />
              <JudgePanel scenario={scenario} version={version} names={names} />
            </div>
            <Exchange meta={m} names={names} actor={actor} version={version} act={act} scenario={scenario} />
            <Assistant scenario={scenario} />
          </>
        )}
      </main>
      {drill && <Drill id={drill} scenario={scenario} weights={w} names={names} version={version} onClose={() => setDrill(null)} />}
    </div>
  );
}

/* ----------------------------------------------------------------- KPIs */
function Kpis({ ov, loading }: { ov: Overview; loading: boolean }) {
  const k = ov.kpis as Record<string, number>;
  const items: [string, string, string?][] = [
    ["Hospitals at risk", `${k.hospitals_at_risk}`, `${k.cells_at_risk} hospital-medicine pairs`],
    ["Outbreak signals", `${k.spikes}`, "demand spikes detected"],
    ["Projected waste", inr(k.waste_value), `${fmt(k.waste_units)} units expiring unused`],
    ["Planned transfers", `${k.moves}`, `${fmt(k.units_moved)} units`],
    ["Unmet doses (14 d)", `${fmt(k.unmet_without)} → ${fmt(k.unmet_with)}`, "without → with system"],
    ["Plan verified", ov.kpis.plan_verified ? "✓ all checks" : "✗ failed", "numbers add up"],
  ];
  return (
    <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6 ${loading ? "opacity-60" : ""}`}>
      {items.map(([l, v, s]) => (
        <div key={l} className="rounded-xl border border-line bg-white px-4 py-3">
          <div className="text-xs text-muted">{l}</div>
          <div className="num text-xl font-bold">{v}</div>
          {s && <div className="text-[11px] text-muted">{s}</div>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Inventory */
function Inventory({ ov, hospitals, meds, onPick, onHospital }: {
  ov: Overview; hospitals: Hospital[]; meds: string[]; onPick: (m: string, h: string) => void; onHospital: (h: string) => void;
}) {
  const at = Object.fromEntries(ov.cells.map((c) => [`${c.hospital}|${c.medicine}`, c]));
  return (
    <Card id="inventory" step={1} title="Inventory" subtitle="Stock on hand · days of cover (colour = shortage risk). Click a cell to forecast it, a hospital to drill down.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 pr-2">Hospital</th>
              {meds.map((x) => <th key={x} className="px-1 py-1 text-center">{x}</th>)}
            </tr>
          </thead>
          <tbody>
            {hospitals.map((h) => (
              <tr key={h.id} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <button className="text-left font-medium hover:text-brand" onClick={() => onHospital(h.id)}>{h.id} · {h.name}</button>
                </td>
                {meds.map((x) => {
                  const c = at[`${h.id}|${x}`] as Cell;
                  return (
                    <td key={x} className="px-0.5 py-0.5">
                      <button onClick={() => onPick(x, h.id)} title={c.message}
                        className="num w-full rounded-md px-1 py-1 text-center leading-tight"
                        style={{ background: RISK[c.risk].soft, boxShadow: c.risk === "ok" ? undefined : `inset 0 0 0 1.5px ${RISK[c.risk].color}` }}>
                        <div className="font-semibold">{fmt(c.stock)}</div>
                        <div className="text-[10px] text-muted">{c.days_of_cover ?? "–"} d{c.incoming ? ` · +${fmt(c.incoming)}` : ""}</div>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- Demand */
function Demand({ ov, meta, scenario, med, hosp, setMed, setHosp, version }: {
  ov: Overview; meta: Meta; scenario: Scenario; med: string; hosp: string;
  setMed: (m: string) => void; setHosp: (h: string) => void; version: number;
}) {
  const s = useApi(() => get<Series>("/forecast", { scenario, medicine: med, hospital: hosp }), [scenario, med, hosp, version]);
  const metrics = ov.metrics.network_by_medicine[med];
  const data = s.data ? [
    ...s.data.history.map((p) => ({ date: p.date.slice(5), actual: p.actual, anomaly: p.anomaly ? p.actual : null })),
    ...s.data.forecast.map((p) => ({ date: p.date.slice(5), p50: p.p50, band: [p.p10, p.p90], gbm: p.gbm })),
  ] : [];
  return (
    <Card id="demand" step={2} title="Predicted demand (next 14 days)"
      subtitle="Gradient boosting + outbreak adjustment; band = 80% interval; red dots = anomaly days"
      actions={<>
        <Select value={med} onChange={setMed}>{meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select value={hosp} onChange={setHosp}>
          <option value="ALL">Whole network</option>
          {meta.hospitals.map((h) => <option key={h.id} value={h.id}>{h.id} · {h.name}</option>)}
        </Select>
      </>}>
      {!s.data ? <Loading /> : (
        <>
          <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <span>Next 7 d: <b className="num">{fmt(s.data.next_7d)}</b></span>
            <span>Next 14 d: <b className="num">{fmt(s.data.next_14d)}</b></span>
            {s.data.spike
              ? <span className="font-semibold text-red-700">Spike detected {s.data.detected_date} (outbreak began {s.data.outbreak_start})</span>
              : <span className="text-muted">No spike detected</span>}
          </div>
          <div className="h-60">
            <ResponsiveContainer>
              <ComposedChart data={data} margin={{ left: -10, right: 8, top: 4 }}>
                <CartesianGrid stroke="#eef1f4" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={6} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Area isAnimationActive={false} dataKey="band" name="P10–P90" stroke="none" fill="#0f766e" fillOpacity={0.15} />
                <Line isAnimationActive={false} dataKey="actual" name="Actual" stroke="#0f172a" dot={false} strokeWidth={1.5} />
                <Line isAnimationActive={false} dataKey="anomaly" name="Anomaly" stroke="none" dot={{ r: 2.5, fill: "#dc2626" }} />
                <Line isAnimationActive={false} dataKey="gbm" name="GBM only" stroke="#94a3b8" strokeDasharray="2 3" dot={false} />
                <Line isAnimationActive={false} dataKey="p50" name="Forecast (P50)" stroke="#0f766e" strokeWidth={2} strokeDasharray="5 3" dot={false} />
                <ReferenceLine x={s.data.forecast[0].date.slice(5)} stroke="#64748b" label={{ value: "today", fontSize: 10, position: "top" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 text-xs text-muted">Weekly demand ({hosp === "ALL" ? "network" : hosp}):{" "}
            {s.data.weekly.slice(-6).map((x) => <span key={x.week_ending} className="num mr-2 font-medium text-ink">{fmt(x.units)}</span>)}
          </div>
        </>
      )}
      <table className="num mt-3 w-full text-xs">
        <caption className="mb-1 text-left text-muted">
          Backtest: last {ov.metrics.holdout_days} days held out. Network-level {med} error, plus all 48 series:
        </caption>
        <thead><tr className="text-left text-muted"><th>Method</th><th>{med} WAPE</th><th>{med} MAPE</th><th>All series MAE</th><th>All series WAPE</th><th>Spike series WAPE</th></tr></thead>
        <tbody>
          {Object.keys(ov.metrics.overall).map((k) => (
            <tr key={k} className="border-t border-line">
              <td>{k.replaceAll("_", " ")}</td>
              <td>{fmt(metrics?.[k]?.wape, 1)}%</td>
              <td>{fmt(metrics?.[k]?.mape, 1)}%</td>
              <td>{fmt(ov.metrics.overall[k].mae, 1)}</td>
              <td>{fmt(ov.metrics.overall[k].wape, 1)}%</td>
              <td>{ov.metrics.spike_series[k] ? `${fmt(ov.metrics.spike_series[k].wape, 1)}%` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* ------------------------------------------------------------- Shortage */
function Shortage({ ov, names, onHospital }: { ov: Overview; names: Names; onHospital: (h: string) => void }) {
  return (
    <Card id="shortage" step={3} title="Shortage risk" subtitle="Days until stock-out vs supplier lead time (bar = stock, line = lead time)">
      {ov.warnings.length === 0 ? <Empty>No shortages predicted.</Empty> : (
        <ul className="space-y-2">
          {ov.warnings.map((c) => {
            const scale = 21;
            const d = Math.min(c.days_to_stockout ?? scale, scale);
            return (
              <li key={c.hospital + c.medicine} className="rounded-lg border border-line p-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <RiskBadge risk={c.risk} />
                  <button className="font-medium hover:text-brand" onClick={() => onHospital(c.hospital)}>{c.hospital}</button>
                  <span className="text-muted">{names.mn(c.medicine)}</span>
                  <span className="num ml-auto text-xs">{c.days_to_stockout ?? "60+"} d · lead {c.lead_days} d</span>
                </div>
                <div className="relative my-1.5 h-2 rounded bg-slate-100">
                  <div className="h-2 rounded" style={{ width: `${(d / scale) * 100}%`, background: RISK[c.risk].color }} />
                  <div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${(Math.min(c.lead_days, scale) / scale) * 100}%` }} />
                </div>
                <p className="text-xs">{c.message}</p>
              </li>
            );
          })}
        </ul>
      )}
      {ov.orders.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted">Supplier orders to place today</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">{ov.orders.map((o) => <li key={o.hospital + o.medicine}>{o.text}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- Expiry */
function Expiry({ ov, names, actor, scenario, act }: { ov: Overview; names: Names; actor: string; scenario: Scenario; act: Act }) {
  return (
    <Card id="expiry" step={4} title="Expiry & wastage risk" subtitle="Stock vs expected demand before expiry (FEFO). Broadcast surplus so other hospitals can claim it.">
      {ov.expiry.length === 0 ? <Empty>No stock projected to expire unused.</Empty> : (
        <ul className="space-y-2">
          {ov.expiry.map((e) => (
            <li key={e.batch_id} className="rounded-lg border border-line p-2.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <b>{e.hospital}</b><span className="text-muted">{names.mn(e.medicine)}</span>
                <span className="text-xs text-muted">batch {e.batch_id} · expires {e.expiry_date} ({e.days_left} d)</span>
                <span className="num ml-auto text-sm font-semibold text-red-700">{fmt(e.projected_waste)} wasted · {inr(e.value)}</span>
              </div>
              <div className="my-1.5 flex h-2 overflow-hidden rounded bg-slate-100" title="green = used before expiry, red = wasted">
                <div className="bg-emerald-500" style={{ width: `${(e.expected_use / e.qty) * 100}%` }} />
                <div className="bg-red-500" style={{ width: `${(e.projected_waste / e.qty) * 100}%` }} />
              </div>
              <p className="text-xs">{e.reason}</p>
              <div className="mt-1.5">
                <Button size="sm" variant="subtle" disabled={e.virtual || !(actor === "NET" || actor === e.hospital)}
                  title={actor === "NET" || actor === e.hospital ? "" : "Act as this hospital (or network admin) to broadcast"}
                  onClick={() => act(() => post("/offers", {
                    hospital: e.hospital, medicine: e.medicine, qty: e.projected_waste, batch_id: e.batch_id,
                    note: `Expires in ${e.days_left} days.`, scenario,
                  }), (r: { offer_id: number; suggested_takers: { hospital: string; can_use: number }[] }) =>
                    `Offer #${r.offer_id} broadcast. AI-matched takers: ${r.suggested_takers.map((t) => `${t.hospital} (${fmt(t.can_use)})`).join(", ") || "none"}`)}>
                  Broadcast surplus offer
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------- Redistribution */
function layout(hs: Hospital[], W: number, Hh: number, pad = 44) {
  const lons = hs.map((h) => h.lon), lats = hs.map((h) => h.lat);
  const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const pts = hs.map((h) => ({ id: h.id, x: pad + ((h.lon - x0) / (x1 - x0)) * (W - 2 * pad), y: pad + ((y1 - h.lat) / (y1 - y0)) * (Hh - 2 * pad) }));
  for (let it = 0; it < 80; it++) {          // push apart the three Mysuru-city hospitals
    for (const a of pts) for (const b of pts) {
      if (a === b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (d < 64) { const p = (64 - d) / 4; a.x -= (dx / d) * p; a.y -= (dy / d) * p; b.x += (dx / d) * p; b.y += (dy / d) * p; }
    }
  }
  return Object.fromEntries(pts.map((p) => [p.id, p]));
}

function NetworkMap({ meta, ov, moves, filterMed, onHospital }: {
  meta: Meta; ov: Overview; moves: Move[]; filterMed: string; onHospital: (h: string) => void;
}) {
  const W = 560, Hh = 420;
  const P = layout(meta.hospitals, W, Hh);
  const max = Math.max(1, ...moves.map((mv) => mv.qty));
  const worst = (h: string) => ov.cells.filter((c) => c.hospital === h && (filterMed === "ALL" || c.medicine === filterMed))
    .reduce((r, c) => (RISK_RANK[c.risk] < RISK_RANK[r] ? c.risk : r), "ok" as Cell["risk"]);
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} className="h-auto w-full rounded-lg bg-slate-50">
      <defs>
        {["need", "rescue"].map((k) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={k === "need" ? "#0f766e" : "#7c3aed"} />
          </marker>
        ))}
      </defs>
      {moves.map((mv, i) => {
        const a = P[mv.from], b = P[mv.to];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const r = 20;
        const sx = a.x + (dx / d) * r, sy = a.y + (dy / d) * r, ex = b.x - (dx / d) * (r + 4), ey = b.y - (dy / d) * (r + 4);
        const bend = 26 + (i % 3) * 14;
        const cx = (sx + ex) / 2 - (dy / d) * bend, cy = (sy + ey) / 2 + (dx / d) * bend;
        const color = mv.kind === "need" ? "#0f766e" : "#7c3aed";
        return (
          <g key={mv.id}>
            <path d={`M${sx},${sy} Q${cx},${cy} ${ex},${ey}`} fill="none" stroke={color} strokeOpacity={0.85}
              strokeWidth={1.5 + (mv.qty / max) * 5} markerEnd={`url(#arrow-${mv.kind})`} className="flow" />
            <text x={(sx + ex) / 4 + cx / 2} y={(sy + ey) / 4 + cy / 2} fontSize="10" fill={color} textAnchor="middle" fontWeight={600}
              paintOrder="stroke" stroke="#f8fafc" strokeWidth={3}>
              {fmt(mv.qty)}{filterMed === "ALL" ? ` ${mv.medicine}` : ""}
            </text>
          </g>
        );
      })}
      {meta.hospitals.map((h) => {
        const p = P[h.id], rk = worst(h.id);
        return (
          <g key={h.id} onClick={() => onHospital(h.id)} className="cursor-pointer">
            <circle cx={p.x} cy={p.y} r={18} fill={RISK[rk].soft} stroke={RISK[rk].color} strokeWidth={2.5} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="13" fontWeight={700}>{h.id}</text>
            <text x={p.x} y={p.y + 32} textAnchor="middle" fontSize="9.5" fill="#475569">{h.city}</text>
          </g>
        );
      })}
      <text x={10} y={Hh - 10} fontSize="9.5" fill="#64748b">Positions from lat/lon (city cluster spread apart). Teal = shortage transfer, violet = expiry rescue.</text>
    </svg>
  );
}

function Redistribution({ ov, meta, names, med, actor, act, scenario, weights, onHospital }: {
  ov: Overview; meta: Meta; names: Names; med: string; actor: string; act: Act; scenario: Scenario; weights: Weights;
  onHospital: (h: string) => void;
}) {
  const [filter, setFilter] = useState("ALL");
  const f = filter === "FOCUS" ? med : filter;
  const moves = ov.plan.moves.filter((mv) => f === "ALL" || mv.medicine === f);
  const v = ov.verification;
  return (
    <Card id="redistribution" step={5} title="Redistribution engine"
      subtitle="MILP (HiGHS) per medicine: respects stock limits, donor P90 reserve, expiry before use, transport time, supplier lead time"
      actions={<>
        <Select value={filter} onChange={setFilter}>
          <option value="ALL">All medicines</option>
          {meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        <Button disabled={actor !== "NET" || ov.plan.moves.length === 0}
          title={actor !== "NET" ? "Switch to Network admin to send the plan" : ""}
          onClick={() => act(() => post("/exchange/send-plan", { scenario, weights }),
            (r: { transfer_ids: number[] }) => `${r.transfer_ids.length} transfer requests sent to donor hospitals for approval`)}>
          Send plan to hospitals
        </Button>
      </>}>
      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <NetworkMap meta={meta} ov={ov} moves={moves} filterMed={f} onHospital={onHospital} />
        <div className="space-y-2">
          {moves.length === 0 ? <Empty>No transfers needed{ov.kpis.moves ? " for this medicine" : " (or already sent to hospitals)"}.</Empty> : moves.map((mv) => (
            <div key={mv.id} className="rounded-lg border border-line p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase text-white ${mv.kind === "need" ? "bg-brand" : "bg-rescue"}`}>
                  {mv.kind === "need" ? "shortage" : "expiry rescue"}
                </span>
                <b>{mv.text}</b>
              </div>
              <p className="mt-1 text-xs text-muted">{mv.reason}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                Batches: {mv.allocations.map((a) => `${a.batch_id} ×${fmt(a.qty)} (exp ${a.expires_in_days} d)`).join(", ")} ·
                arrives day {mv.arrival_day} · covers ~{mv.covers_days} days at {mv.to}
                {mv.rescued_from_expiry > 0 && ` · rescues ${fmt(mv.rescued_from_expiry)} from expiry`}
              </p>
            </div>
          ))}
          {ov.plan.shortfalls.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-2.5 text-xs">
              <b>Still short before supplier resupply</b> (scarce stock shared by fair-share tiers, then priority):{" "}
              {ov.plan.shortfalls.map((s) => `${s.hospital} ${s.medicine}: needs ${fmt(s.need)}, gets ${fmt(s.received)}`).join(" · ")}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Plan verification {v.passed ? <span className="text-emerald-700">✓ passed</span> : <span className="text-red-700">✗ failed</span>}</h3>
          <ul className="space-y-1 text-xs">
            {v.checks.map((c) => (
              <li key={c.name}><span className={c.passed ? "text-emerald-700" : "text-red-700"}>{c.passed ? "✓" : "✗"}</span> <b>{c.name}</b> · <span className="text-muted">{c.detail}</span></li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Unmet demand before resupply on affected hospitals: {fmt(v.summary.unmet_window_before)} → {fmt(v.summary.unmet_window_after)} ·
            projected waste {fmt(v.summary.waste_before)} → {fmt(v.summary.waste_after)}
          </p>
        </div>
        <div className="overflow-x-auto">
          <h3 className="mb-2 text-sm font-semibold">Ledger (before − out + in = after)</h3>
          <table className="num w-full text-xs">
            <thead><tr className="text-left text-muted"><th>Hosp</th><th>Med</th><th>Before</th><th>Out</th><th>In</th><th>After</th><th>Stock-out d</th><th>Waste</th></tr></thead>
            <tbody>
              {v.ledger.filter((r) => f === "ALL" || r.medicine === f).map((r) => (
                <tr key={r.hospital + r.medicine} className="border-t border-line">
                  <td>{r.hospital}</td><td>{r.medicine}</td><td>{fmt(r.before)}</td><td>{r.out ? `−${fmt(r.out)}` : ""}</td>
                  <td>{r.in ? `+${fmt(r.in)}` : ""}</td><td className="font-semibold">{fmt(r.after)}</td>
                  <td>{r.dts_before ?? "60+"} → {r.dts_after ?? "60+"}</td><td>{fmt(r.waste_before)} → {fmt(r.waste_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">Network totals: {v.totals.map((t) => `${t.medicine} ${fmt(t.before)}→${fmt(t.after)}`).join(" · ")}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted">{names.hn("AI")} proposes; donor hospitals approve in the exchange below.</p>
    </Card>
  );
}

/* ------------------------------------------------------------- Priority */
function PriorityPanel({ ov, meta, names, med, setMed, weights, setWeights }: {
  ov: Overview; meta: Meta; names: Names; med: string; setMed: (m: string) => void; weights: Weights; setWeights: (w: Weights) => void;
}) {
  const [draft, setDraft] = useState<Weights>(weights);
  const cells = ov.cells.filter((c) => c.medicine === med).sort((a, b) => b.priority.score - a.priority.score);
  const need = cells.reduce((s, c) => s + c.need, 0), spare = cells.reduce((s, c) => s + c.surplus, 0);
  const got = (h: string) => ov.plan.moves.filter((mv) => mv.medicine === med && mv.to === h).reduce((s, mv) => s + mv.qty, 0);
  return (
    <Card id="priority" step={6} title="Priority facilities"
      subtitle="Transparent score = weighted sum of 5 factors (0–100). Used by the optimiser when hospitals compete for scarce stock."
      actions={<Select value={med} onChange={setMed}>{meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}>
      <p className="mb-3 text-xs">
        {need > spare
          ? <span className="font-semibold text-red-700">Scarce: hospitals need {fmt(need)} {names.unit(med)} before resupply, network spare is only {fmt(spare)}.</span>
          : <span className="text-muted">Need before resupply {fmt(need)} vs network spare {fmt(spare)}.</span>}
      </p>
      <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
        <div className="space-y-2">
          {cells.map((c) => (
            <div key={c.hospital}>
              <div className="flex items-center gap-2 text-sm">
                <b className="w-5">{c.hospital}</b>
                <div className="flex h-4 flex-1 overflow-hidden rounded bg-slate-100">
                  {Object.entries(c.priority.contributions).map(([k, v]) => (
                    <div key={k} title={`${FACTOR_LABELS[k]}: ${v}`} style={{ width: `${v}%`, background: FACTOR_COLORS[k] }} />
                  ))}
                </div>
                <span className="num w-10 text-right font-semibold">{c.priority.score}</span>
                <span className="num w-36 text-right text-xs text-muted">{c.need ? `need ${fmt(c.need)} · gets ${fmt(got(c.hospital))}` : ""}</span>
              </div>
              {(c.need > 0 || cells.indexOf(c) < 3) && <p className="ml-7 text-[11px] text-muted">{c.priority.explanation}</p>}
            </div>
          ))}
          <div className="flex flex-wrap gap-3 pt-1 text-[11px]">
            {Object.entries(FACTOR_LABELS).map(([k, l]) => (
              <span key={k} className="inline-flex items-center gap-1"><i className="inline-block size-2.5 rounded-sm" style={{ background: FACTOR_COLORS[k] }} />{l}</span>
            ))}
          </div>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Weights</h3>
          {Object.keys(FACTOR_LABELS).map((k) => (
            <label key={k} className="mb-2 block text-xs">
              {FACTOR_LABELS[k]} <span className="num float-right">{(draft[k] ?? 0).toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={draft[k] ?? 0} className="w-full"
                onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} />
            </label>
          ))}
          <Button size="sm" onClick={() => setWeights(draft)}>Apply & re-plan</Button>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(meta.default_weights); setWeights(meta.default_weights); }}>Reset</Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- Impact */
function Impact({ weights, version }: { weights: Weights; version: number }) {
  const [view, setView] = useState<Scenario>("outbreak");
  const cmp = useApi(() => get<Record<Scenario, Outcome>>("/compare", weightParams(weights)), [JSON.stringify(weights), version]);
  const o = cmp.data?.[view];
  const rows: [string, keyof Outcome["with"]][] = [
    ["Hospital-medicine pairs that stock out", "stockout_cells"], ["Stock-out days", "stockout_days"],
    ["Unmet patient doses", "unmet_units"], ["…of which life-saving medicines", "unmet_critical"], ["Units expiring unused (projected)", "waste"],
  ];
  return (
    <Card id="impact" title="Impact: with vs without the system" subtitle="Simulated over the next 14 days on hidden ground-truth demand"
      actions={<Segmented size="sm" value={view} onChange={setView}
        options={[{ value: "normal", label: "Before outbreak" }, { value: "outbreak", label: "After outbreak" }]} />}>
      {!o ? <Loading /> : (
        <>
          <table className="num w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th></th><th>Without system</th><th>With system</th><th>Change</th></tr></thead>
            <tbody>
              {rows.map(([l, k]) => (
                <tr key={k} className="border-t border-line">
                  <td className="py-1 text-xs">{l}</td><td>{fmt(o.without[k])}</td><td className="font-semibold">{fmt(o.with[k])}</td>
                  <td className={o.with[k] < o.without[k] ? "text-emerald-700" : "text-muted"}>
                    {o.without[k] ? `${Math.round((100 * (o.with[k] - o.without[k])) / o.without[k])}%` : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted">Without = no transfers, hospitals reorder only when they run out. With = AI transfers + proactive orders today.</p>
          <div className="mt-2 h-40">
            <ResponsiveContainer>
              <BarChart data={o.daily.map((d) => ({ ...d, date: d.date.slice(5) }))} margin={{ left: -10 }}>
                <CartesianGrid stroke="#eef1f4" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip />
                <Bar isAnimationActive={false} dataKey="without" name="Unmet doses without" fill="#fca5a5" />
                <Bar isAnimationActive={false} dataKey="with" name="Unmet doses with" fill="#0f766e" />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- Judge */
function JudgePanel({ scenario, version, names }: { scenario: Scenario; version: number; names: Names }) {
  const j = useApi(() => get<Judge>("/judge", { scenario }), [scenario, version]);
  return (
    <Card id="judge" title="Judge scenario: 20,000 units, demand 2,000 → 5,500 / week" subtitle={`${names.mn("OSEL")}, whole network`}>
      {!j.data ? <Loading /> : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-4">
            <div><div className="text-xs text-muted">Network stock</div><b className="num text-lg">{fmt(j.data.stock_total)}</b></div>
            <div><div className="text-xs text-muted">Weekly demand (last 5 wks)</div><b className="num">{j.data.weekly_demand.map((x) => fmt(x)).join(" → ")}</b></div>
            <div><div className="text-xs text-muted">Aggregate cover</div><b className="num">{j.data.aggregate_cover_days} d</b></div>
            <div><div className="text-xs text-muted">Forecast 14 d</div><b className="num">{fmt(j.data.forecast_14d.p50)}</b> <span className="text-xs text-muted">({fmt(j.data.forecast_14d.p10)}–{fmt(j.data.forecast_14d.p90)})</span></div>
          </div>
          <p className="text-xs">{j.data.statement}</p>
          <table className="num w-full text-xs">
            <thead><tr className="text-left text-muted"><th>Hosp</th><th>Stock</th><th>Runs out</th><th>Lead</th><th>Risk</th><th>Transfer</th><th>After</th></tr></thead>
            <tbody>
              {j.data.hospitals.slice().sort((a, b) => a.hospital.localeCompare(b.hospital)).map((c) => {
                const l = j.data!.ledger.find((r) => r.hospital === c.hospital);
                return (
                  <tr key={c.hospital} className="border-t border-line">
                    <td>{c.hospital}</td><td>{fmt(c.stock)}</td><td>{c.days_to_stockout ?? "60+"} d</td><td>{c.lead_days} d</td>
                    <td><RiskBadge risk={c.risk} /></td>
                    <td>{l ? (l.out ? `−${fmt(l.out)}` : `+${fmt(l.in)}`) : ""}</td><td>{l ? fmt(l.after) : fmt(c.stock)}</td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-ink font-semibold"><td>Total</td><td>{fmt(j.data.totals.before)}</td><td colSpan={4}>moved {fmt(j.data.totals.moved)}</td><td>{fmt(j.data.totals.after)}</td></tr>
            </tbody>
          </table>
          <p className={`text-xs font-semibold ${j.data.passed ? "text-emerald-700" : "text-red-700"}`}>
            {j.data.passed ? "✓" : "✗"} {j.data.checks.filter((c) => c.passed).length}/{j.data.checks.length} verification checks passed
          </p>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------- Exchange */
const STATUS_CLS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800", approved: "bg-sky-100 text-sky-800", in_transit: "bg-indigo-100 text-indigo-800",
  delivered: "bg-emerald-100 text-emerald-800", declined: "bg-red-100 text-red-800", cancelled: "bg-slate-200 text-slate-700",
};

function Exchange({ meta, names, actor, version, act, scenario }: {
  meta: Meta; names: Names; actor: string; version: number; act: Act; scenario: Scenario;
}) {
  const b = useApi(() => get<Board>("/exchange", { hospital: actor === "NET" ? undefined : actor }), [actor, version]);
  const [open, setOpen] = useState<number | null>(null);
  const [form, setForm] = useState({ medicine: "OSEL", qty: 200, to: "ALL", body: "" });
  const isHosp = actor !== "NET";
  const can = (t: Transfer, a: string) => {
    const admin = actor === "NET";
    if (a === "approve") return t.status === "pending" && (admin || actor === t.awaiting);
    if (a === "decline") return t.status === "pending" && (admin || actor === t.from_id || actor === t.to_id);
    if (a === "dispatch") return t.status === "approved" && (admin || actor === t.from_id);
    if (a === "receive") return t.status === "in_transit" && (admin || actor === t.to_id);
    if (a === "cancel") return (t.status === "pending" || t.status === "approved") && (admin || actor === t.from_id || actor === t.to_id);
    return false;
  };
  const doAct = (t: Transfer, a: string) => act(() => post(`/transfers/${t.id}/action`, { action: a, actor }), `Transfer #${t.id}: ${a} done`);
  const ask = (label: string, def: number) => { const v = window.prompt(label, String(def)); return v ? Math.max(0, Number(v)) : 0; };

  return (
    <Card id="exchange" title="Hospital exchange: hospitals talk to each other"
      subtitle={`Acting as ${names.hn(actor)}. Excess stock → broadcast offer → AI matches takers → claim → approve → dispatch → receive (stock moves in the DB).`}>
      {!b.data ? <Loading /> : (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Transfers {isHosp && b.data.todo.length > 0 && <span className="ml-1 rounded-full bg-red-600 px-2 text-xs text-white">{b.data.todo.length} awaiting you</span>}
            </h3>
            {b.data.transfers.length === 0 ? <Empty>No transfers yet. Send the AI plan (step 5) or claim an offer.</Empty> : (
              <ul className="space-y-2">
                {b.data.transfers.slice(0, 30).map((t) => (
                  <li key={t.id} className={`rounded-lg border p-2.5 text-sm ${t.awaiting === actor ? "border-amber-400 bg-amber-50/40" : "border-line"}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <b>#{t.id}</b>
                      <span>{fmt(t.qty)} {names.unit(t.medicine_id)} {t.medicine_id}</span>
                      <span className="text-muted">{t.from_id} → {t.to_id}</span>
                      <span className={`rounded px-1.5 text-[11px] font-semibold ${STATUS_CLS[t.status]}`}>{t.status.replace("_", " ")}</span>
                      {t.awaiting && <span className="text-[11px] text-muted">awaiting {t.awaiting}</span>}
                      <span className="text-[11px] text-muted">via {t.origin.replace("_", " ")}</span>
                      <div className="ml-auto flex gap-1">
                        {(["approve", "dispatch", "receive", "decline", "cancel"] as const).filter((a) => can(t, a)).map((a) => (
                          <Button key={a} size="sm" variant={a === "decline" || a === "cancel" ? "danger" : "primary"} onClick={() => doAct(t, a)}>{a}</Button>
                        ))}
                        <Button size="sm" variant="ghost" onClick={() => setOpen(open === t.id ? null : t.id)}>thread</Button>
                      </div>
                    </div>
                    {open === t.id && <Thread id={t.id} actor={actor} version={version} act={act} names={names} />}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Open surplus offers</h3>
              {b.data.offers.filter((o) => o.status === "open").length === 0 ? <p className="text-xs text-muted">None. Broadcast one from Expiry risk (step 4) or below.</p> :
                b.data.offers.filter((o) => o.status === "open").map((o) => (
                  <div key={o.id} className="mb-1 flex items-center gap-2 text-xs">
                    <span>#{o.id} <b>{o.hospital_id}</b> offers {fmt(o.remaining)} {o.medicine_id} (exp {o.expiry_date})</span>
                    {isHosp && actor !== o.hospital_id && (
                      <Button size="sm" variant="subtle" onClick={() => { const q = ask(`Claim how many ${o.medicine_id}?`, o.remaining); if (q) act(() => post(`/offers/${o.id}/claim`, { hospital: actor, qty: q }), `Claimed ${q} from offer #${o.id}; awaiting ${o.hospital_id}`); }}>claim</Button>
                    )}
                  </div>
                ))}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Open stock requests</h3>
              {b.data.requests.filter((r) => r.status === "open").length === 0 ? <p className="text-xs text-muted">None.</p> :
                b.data.requests.filter((r) => r.status === "open").map((r) => (
                  <div key={r.id} className="mb-1 flex items-center gap-2 text-xs">
                    <span>#{r.id} <b>{r.hospital_id}</b> needs {fmt(r.remaining)} {r.medicine_id} within {r.needed_within_days} d</span>
                    {isHosp && actor !== r.hospital_id && (
                      <Button size="sm" variant="subtle" onClick={() => { const q = ask(`Send how many ${r.medicine_id}?`, r.remaining); if (q) act(() => post(`/requests/${r.id}/respond`, { donor: actor, qty: q }), `Offered ${q} to ${r.hospital_id}; awaiting their approval`); }}>respond</Button>
                    )}
                  </div>
                ))}
            </div>
            {isHosp ? (
              <div className="rounded-lg bg-slate-50 p-3 text-xs">
                <h3 className="mb-2 font-semibold">{actor}: post to the network</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={form.medicine} onChange={(v) => setForm({ ...form, medicine: v })}>
                    {meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}
                  </Select>
                  <input type="number" className="h-8 w-24 rounded-lg border border-line px-2" value={form.qty}
                    onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })} />
                  <Button size="sm" onClick={() => act(() => post("/requests", { hospital: actor, medicine: form.medicine, qty: form.qty, scenario }),
                    (r: { request_id: number; suggested_donors: { hospital: string; surplus: number }[] }) =>
                      `Request #${r.request_id} broadcast. AI-suggested donors: ${r.suggested_donors.map((d) => `${d.hospital} (${fmt(d.surplus)})`).join(", ") || "none"}`)}>
                    Request stock
                  </Button>
                  <Button size="sm" variant="subtle" onClick={() => act(() => post("/offers", { hospital: actor, medicine: form.medicine, qty: form.qty, scenario }),
                    (r: { offer_id: number; suggested_takers: { hospital: string; can_use: number }[] }) =>
                      `Offer #${r.offer_id} broadcast. AI-matched takers: ${r.suggested_takers.map((t) => `${t.hospital} (${fmt(t.can_use)})`).join(", ") || "none"}`)}>
                    Offer surplus
                  </Button>
                </div>
              </div>
            ) : <p className="rounded-lg bg-slate-50 p-3 text-xs text-muted">Switch “Acting as” to a hospital to request stock, offer surplus, claim offers or approve transfers as that hospital.</p>}
            <div>
              <h3 className="mb-1 text-sm font-semibold">Messages</h3>
              <div className="mb-2 flex gap-2">
                <Select value={form.to} onChange={(v) => setForm({ ...form, to: v })}>
                  <option value="ALL">to all</option>
                  {meta.hospitals.filter((h) => h.id !== actor).map((h) => <option key={h.id} value={h.id}>to {h.id}</option>)}
                </Select>
                <input className="h-8 flex-1 rounded-lg border border-line px-2 text-sm" placeholder="Write a message…" value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })} />
                <Button size="sm" disabled={!form.body.trim()} onClick={() => act(() => post("/messages", { sender: actor, recipient: form.to, body: form.body }), "Message sent").then(() => setForm((f) => ({ ...f, body: "" })))}>send</Button>
              </div>
              <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
                {b.data.messages.slice(0, 40).map((x) => (
                  <li key={x.id} className="rounded bg-slate-50 px-2 py-1">
                    <span className="font-semibold">{x.sender}</span> → {x.recipient} <span className="text-muted">{x.ts.slice(11, 16)} · {x.kind}</span>
                    <div>{x.body}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Thread({ id, actor, version, act, names }: { id: number; actor: string; version: number; act: Act; names: Names }) {
  const t = useApi(() => get<Board>("/exchange"), [version]);
  const [text, setText] = useState("");
  const tr = t.data?.transfers.find((x) => x.id === id);
  const msgs = (t.data?.messages ?? []).filter((m) => m.transfer_id === id).slice().reverse();
  return (
    <div className="mt-2 rounded-md bg-slate-50 p-2 text-xs">
      {tr && <p className="mb-1 text-muted">{tr.reason} Batches: {tr.allocations.map((a) => `${a.batch_id} ×${a.qty}`).join(", ")}</p>}
      {msgs.map((m) => <p key={m.id}><b>{names.hn(m.sender)}:</b> {m.body}</p>)}
      {tr && (
        <div className="mt-1 flex gap-2">
          <input className="h-7 flex-1 rounded border border-line px-2" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply on this transfer…" />
          <Button size="sm" disabled={!text.trim()} onClick={() => act(() => post("/messages", {
            sender: actor, recipient: actor === tr.from_id ? tr.to_id : tr.from_id, body: text, transfer_id: id,
          }), "Reply sent").then(() => setText(""))}>reply</Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Assistant */
function Assistant({ scenario }: { scenario: Scenario }) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ q: string; r?: AssistantReply; err?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const askQ = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    setQ("");
    try {
      const r = await post<AssistantReply>("/assistant", { question, scenario });
      setLog((l) => [{ q: question, r }, ...l]);
    } catch (e) {
      setLog((l) => [{ q: question, err: (e as Error).message }, ...l]);
    }
    setBusy(false);
  };
  const samples = ["Which hospitals are at highest shortage risk next week?", "What will expire unused?",
    "Why move oseltamivir to City General?", "Who should get ceftriaxone first?", "Check the 20,000 unit scenario", "Is there an outbreak?"];
  return (
    <Card id="assistant" title="AI assistant" subtitle="Answers only from backend tool data (Gemini function-calling if GEMINI_API_KEY is set, otherwise grounded templates)">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); askQ(q); }}>
        <input className="h-9 flex-1 rounded-lg border border-line px-3 text-sm" placeholder="Ask about shortages, expiry, transfers, priorities…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" disabled={busy}>{busy ? "Thinking…" : "Ask"}</Button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {samples.map((s) => <button key={s} onClick={() => askQ(s)} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs hover:bg-slate-200">{s}</button>)}
      </div>
      <div className="mt-3 space-y-3">
        {log.map((x, i) => (
          <div key={i} className="rounded-lg border border-line p-3 text-sm">
            <p className="font-semibold">Q: {x.q}</p>
            {x.err ? <p className="text-red-700">{x.err}</p> : (
              <>
                <p className="mt-1 whitespace-pre-wrap">{x.r!.answer}</p>
                <p className="mt-1 text-[11px] text-muted">
                  mode: {x.r!.mode} · data from: {x.r!.tools.map((t) => t.name).join(", ") || "none"}{x.r!.note ? ` · ${x.r!.note}` : ""}
                </p>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ Drill-down */
function Drill({ id, scenario, weights, names, version, onClose }: {
  id: string; scenario: Scenario; weights: Weights; names: Names; version: number; onClose: () => void;
}) {
  const d = useApi(() => get<HospitalDetail>(`/hospital/${id}`, { scenario, ...weightParams(weights) }), [id, scenario, JSON.stringify(weights), version]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="drawer h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">{id} · {names.hn(id)}</h2>
            {d.data && <p className="text-xs text-muted">{d.data.hospital.city} · {d.data.hospital.beds} beds · {fmt(d.data.hospital.patient_load)} patients/day · ER intensity {d.data.hospital.emergency_index}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        {!d.data ? <Loading /> : (
          <div className="space-y-4 text-sm">
            <table className="num w-full text-xs">
              <thead><tr className="text-left text-muted"><th>Medicine</th><th>Stock</th><th>Fcst 7d</th><th>Runs out</th><th>Lead</th><th>Risk</th><th>Priority</th></tr></thead>
              <tbody>
                {d.data.cells.map((c) => (
                  <tr key={c.medicine} className="border-t border-line" title={c.message}>
                    <td>{names.mn(c.medicine)}</td><td>{fmt(c.stock)}{c.incoming ? ` (+${fmt(c.incoming)})` : ""}</td><td>{fmt(c.forecast_7d)}</td>
                    <td>{c.days_to_stockout ?? "60+"} d</td><td>{c.lead_days} d</td><td><RiskBadge risk={c.risk} /></td><td>{c.priority.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.data.cells.filter((c) => c.risk !== "ok").map((c) => <p key={c.medicine} className="text-xs">• {c.message}</p>)}
            {d.data.moves.length > 0 && <div><h3 className="font-semibold">Planned transfers</h3>{d.data.moves.map((mv) => <p key={mv.id} className="text-xs">• {mv.text}</p>)}</div>}
            {d.data.orders.length > 0 && <div><h3 className="font-semibold">Supplier orders</h3>{d.data.orders.map((o) => <p key={o.medicine} className="text-xs">• {o.text}</p>)}</div>}
            {d.data.expiry.length > 0 && <div><h3 className="font-semibold">Expiry risk</h3>{d.data.expiry.map((e) => <p key={e.batch_id} className="text-xs">• {e.reason}</p>)}</div>}
            <div>
              <h3 className="font-semibold">Batches (FEFO order)</h3>
              <table className="num w-full text-xs">
                <thead><tr className="text-left text-muted"><th>Medicine</th><th>Batch</th><th>Qty</th><th>Expires</th><th></th></tr></thead>
                <tbody>
                  {d.data.batches.map((b) => (
                    <tr key={b.batch_id} className="border-t border-line">
                      <td>{b.medicine}</td><td>{b.batch_id}</td><td>{fmt(b.qty)}</td><td>{b.expiry_date} ({b.days_left} d)</td>
                      <td className="text-muted">{b.virtual ? "in pipeline" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="font-semibold">Exchange</h3>
              {d.data.exchange.transfers.length === 0 ? <p className="text-xs text-muted">No transfers.</p> :
                d.data.exchange.transfers.map((t) => <p key={t.id} className="text-xs">#{t.id} {t.from_id}→{t.to_id} {fmt(t.qty)} {t.medicine_id} · {t.status}{t.awaiting ? ` (awaiting ${t.awaiting})` : ""}</p>)}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
