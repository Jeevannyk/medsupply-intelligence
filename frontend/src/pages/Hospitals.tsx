import { ArrowLeft, Building2, MapPin } from "lucide-react";
import { get, useApi, weightParams, type Cell, type HospitalDetail } from "../api";
import { Card, Loading, Pill, RISK, RISK_RANK, RiskBadge, fmt } from "../components/ui";
import { useApp } from "../context";
import { go, Link } from "../router";

export default function HospitalsPage() {
  const { ov, meta } = useApp();
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {meta.hospitals.map((h, i) => {
        const cs = ov.cells.filter((c) => c.hospital === h.id);
        const worst = cs.reduce((r, c) => (RISK_RANK[c.risk] < RISK_RANK[r] ? c.risk : r), "ok" as Cell["risk"]);
        const atRisk = cs.filter((c) => c.risk !== "ok").length;
        return (
          <button key={h.id} onClick={() => go(`/hospitals/${h.id}`)} style={{ animationDelay: `${i * 40}ms`, borderTop: `4px solid ${RISK[worst].color}` }}
            className="card-surface card-hover rise rounded-2xl border border-line bg-white p-4 text-left">
            <div className="flex items-start justify-between">
              <span className="grid size-10 place-items-center rounded-xl bg-brand-soft text-sm font-extrabold text-brand">{h.id}</span>
              <RiskBadge risk={worst} />
            </div>
            <h3 className="mt-3 text-sm leading-5 font-semibold">{h.name}</h3>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted"><MapPin size={12} />{h.city}</p>
            <dl className="num mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center text-[11px] text-muted">
              <div><dt>Beds</dt><dd className="text-sm font-bold text-ink">{fmt(h.beds)}</dd></div>
              <div><dt>Patients/day</dt><dd className="text-sm font-bold text-ink">{fmt(h.patient_load)}</dd></div>
              <div><dt>At risk</dt><dd className={`text-sm font-bold ${atRisk ? "text-red-600" : "text-emerald-600"}`}>{atRisk}/6</dd></div>
            </dl>
          </button>
        );
      })}
    </div>
  );
}

export function HospitalDetailPage({ id }: { id: string }) {
  const { scenario, weights, names, version } = useApp();
  const d = useApi(() => get<HospitalDetail>(`/hospital/${id}`, { scenario, ...weightParams(weights) }), [id, scenario, JSON.stringify(weights), version]);
  return (
    <div className="space-y-5">
      <Link to="/hospitals" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"><ArrowLeft size={15} />All hospital nodes</Link>
      {!d.data ? <Loading h="h-96" /> : (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-brand to-indigo-400 text-xl font-extrabold text-white shadow-lg">{id}</span>
              <div>
                <h2 className="text-xl font-bold tracking-tight">{names.hn(id)}</h2>
                <p className="flex items-center gap-1 text-sm text-muted"><MapPin size={14} />{d.data.hospital.city}</p>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                <Pill tone="brand">{fmt(d.data.hospital.beds)} beds</Pill>
                <Pill tone="slate">{fmt(d.data.hospital.patient_load)} patients/day</Pill>
                <Pill tone="amber">ER intensity {d.data.hospital.emergency_index}</Pill>
              </div>
            </div>
          </Card>

          <Card title="Medicines" icon={<Building2 size={18} />} subtitle="Stock, forecast and risk at this hospital" flush>
            <div className="overflow-x-auto px-5 pb-5">
              <table className="num w-full text-xs">
                <thead><tr className="text-left text-muted"><th className="py-2">Medicine</th><th>On hand</th><th>Forecast 7 d</th><th>Runs out</th><th>Lead</th><th>Risk</th><th>Priority</th></tr></thead>
                <tbody>
                  {d.data.cells.map((c) => (
                    <tr key={c.medicine} className="border-t border-line" title={c.message}>
                      <td className="py-2 font-medium">{names.mn(c.medicine)}</td><td>{fmt(c.physical)}{c.incoming ? ` (+${fmt(c.incoming)} in)` : ""}{c.outgoing ? ` (−${fmt(c.outgoing)} out)` : ""}</td><td>{fmt(c.forecast_7d)}</td>
                      <td>{c.days_to_stockout ?? "60+"} d</td><td>{c.lead_days} d</td><td><RiskBadge risk={c.risk} /></td><td className="font-bold">{c.priority.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Actions & alerts">
              <ul className="space-y-1.5 text-xs leading-5">
                {d.data.cells.filter((c) => c.risk !== "ok").map((c) => <li key={c.medicine}>• {c.message}</li>)}
                {d.data.moves.map((mv) => <li key={mv.id} className="font-medium text-brand-ink">→ {mv.text}</li>)}
                {d.data.orders.map((o) => <li key={o.medicine}>🚚 {o.text}</li>)}
                {d.data.expiry.map((e) => <li key={e.batch_id} className="text-red-700">⏳ {e.reason}</li>)}
              </ul>
              {d.data.cells.every((c) => c.risk === "ok") && d.data.moves.length + d.data.orders.length + d.data.expiry.length === 0 && <p className="text-sm text-muted">Nothing needs attention.</p>}
            </Card>
            <Card title="Exchange activity">
              {d.data.exchange.transfers.length === 0 ? <p className="text-sm text-muted">No transfers.</p> : (
                <ul className="space-y-1.5 text-xs">
                  {d.data.exchange.transfers.map((t) => (
                    <li key={t.id} className="flex items-center gap-2"><b>#{t.id}</b> {t.from_id} → {t.to_id} <span className="num">{fmt(t.qty)} {t.medicine_id}</span><Pill>{t.status.replace("_", " ")}</Pill>{t.awaiting && <span className="text-muted">awaiting {t.awaiting}</span>}</li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Batches" subtitle="First-expiry-first-out order" flush>
            <div className="max-h-96 overflow-auto px-5 pb-5 scroll-thin">
              <table className="num w-full text-xs">
                <thead className="sticky top-0 bg-white"><tr className="text-left text-muted"><th className="py-2">Medicine</th><th>Batch</th><th>Qty</th><th>Expires</th><th></th></tr></thead>
                <tbody>
                  {d.data.batches.map((b) => (
                    <tr key={b.batch_id} className="border-t border-line">
                      <td className="py-1.5">{b.medicine}</td><td>{b.batch_id}</td><td>{fmt(b.qty)}</td>
                      <td className={b.days_left <= 30 ? "font-semibold text-red-600" : ""}>{b.expiry_date} ({b.days_left} d)</td><td className="text-muted">{b.virtual ? "in pipeline" : ""}</td>
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
