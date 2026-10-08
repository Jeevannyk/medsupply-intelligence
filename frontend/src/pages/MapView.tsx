import { useState } from "react";
import { Map as MapIcon } from "lucide-react";
import type { Cell } from "../api";
import { NetworkMap } from "../components/charts";
import { Card, RISK, RISK_RANK, RiskBadge, Select, fmt } from "../components/ui";
import { useApp } from "../context";
import { go } from "../router";
import { MoveCards } from "./Redistribution";
import { RiskLegend } from "./Inventory";

export default function MapPage() {
  const { ov, meta } = useApp();
  const [filter, setFilter] = useState("ALL");
  const moves = ov.plan.moves.filter((mv) => filter === "ALL" || mv.medicine === filter);
  const dist = meta.transport.filter((t) => t.from < t.to).sort((a, b) => a.km - b.km);
  return (
    <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
      <Card title="Network map" icon={<MapIcon size={18} />}
        subtitle="Hospitals placed by real coordinates (same-city sites spread apart). Node colour = worst shortage risk. Hover a hospital to focus its transfers."
        actions={<>
          <RiskLegend />
          <Select value={filter} onChange={setFilter}>
            <option value="ALL">All medicines</option>
            {meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </>}>
        <NetworkMap meta={meta} ov={ov} moves={moves} filterMed={filter} onHospital={(h) => go(`/hospitals/${h}`)} />
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {meta.hospitals.map((h) => {
            const cs = ov.cells.filter((c) => c.hospital === h.id);
            const worst = cs.reduce((r, c) => (RISK_RANK[c.risk] < RISK_RANK[r] ? c.risk : r), "ok" as Cell["risk"]);
            return (
              <button key={h.id} onClick={() => go(`/hospitals/${h.id}`)} className="rounded-xl border border-line p-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
                style={{ borderLeft: `4px solid ${RISK[worst].color}` }}>
                <div className="text-xs font-bold">{h.id} · {h.city}</div>
                <div className="truncate text-[11px] text-muted">{h.name}</div>
                <div className="mt-1"><RiskBadge risk={worst} /></div>
              </button>
            );
          })}
        </div>
      </Card>
      <div className="space-y-5">
        <Card title="Transfers on the map" subtitle={`${moves.length} proposed`}><div className="max-h-96 overflow-y-auto pr-1 scroll-thin"><MoveCards filter={filter} /></div></Card>
        <Card title="Road links" subtitle="Real driving distance and time (OSRM). Shortest links first.">
          <table className="num w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="pb-1">Route</th><th>km</th><th>hours</th></tr></thead>
            <tbody>
              {dist.slice(0, 10).map((t) => (
                <tr key={t.from + t.to} className="border-t border-line"><td className="py-1.5 font-semibold">{t.from} ↔ {t.to}</td><td>{fmt(t.km, 1)}</td><td>{fmt(t.hours, 2)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
