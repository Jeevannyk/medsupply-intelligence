import { Pill as PillIcon } from "lucide-react";
import { Card, Pill, fmt, inr } from "../components/ui";
import { useApp } from "../context";

const CRIT: Record<number, { label: string; tone: "red" | "amber" | "slate" }> = {
  3: { label: "Life-saving", tone: "red" }, 2: { label: "Essential", tone: "amber" }, 1: { label: "Routine", tone: "slate" },
};

export default function MedicinesPage() {
  const { meta, ov, names } = useApp();
  return (
    <Card title="Medicine catalogue" icon={<PillIcon size={18} />} subtitle="Criticality drives priority scoring; alternatives reduce a hospital's priority when stock of a substitute is on hand." flush>
      <div className="overflow-x-auto px-5 pb-5">
        <table className="num w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="py-2">Medicine</th><th>Criticality</th><th>Shelf life</th><th>Unit cost</th><th>Alternatives</th><th>Network stock</th><th>Forecast / day</th></tr></thead>
          <tbody>
            {meta.medicines.map((m) => {
              const cs = ov.cells.filter((c) => c.medicine === m.id);
              return (
                <tr key={m.id} className="border-t border-line">
                  <td className="py-3"><b>{m.name}</b><div className="text-[11px] text-muted">{m.id} · {m.unit}</div></td>
                  <td><Pill tone={CRIT[m.criticality].tone}>{CRIT[m.criticality].label}</Pill></td>
                  <td>{fmt(m.shelf_life_days)} d</td><td>₹{fmt(m.unit_cost, 2)}</td>
                  <td className="text-xs">{m.alternatives.length ? m.alternatives.map((a) => names.mn(a)).join(", ") : <span className="text-muted">none</span>}</td>
                  <td className="font-semibold">{fmt(cs.reduce((s, c) => s + c.physical, 0))}</td>
                  <td>{fmt(cs.reduce((s, c) => s + c.daily_forecast, 0))}<div className="text-[11px] text-muted">{inr(cs.reduce((s, c) => s + c.daily_forecast, 0) * m.unit_cost)}/day</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
