import { ArrowRight, Boxes, Building2, PackageX, Share2, ShieldCheck, Siren, Truck, Waves } from "lucide-react";
import { NetworkMap } from "../components/charts";
import { AnimatedNumber, Button, Card, Stat, fmt, inr } from "../components/ui";
import { useApp } from "../context";
import { go } from "../router";
import { AssistantPanel } from "./Assistant";
import { DemandPanel } from "./Demand";
import { ExpiryList } from "./Expiry";
import { InventoryGrid, RiskLegend } from "./Inventory";
import { MoveCards } from "./Redistribution";
import { ShortageList } from "./Shortage";

const more = (to: string, label = "View all") => (
  <Button size="sm" variant="ghost" icon={<ArrowRight size={14} />} onClick={() => go(to)} className="flex-row-reverse">{label}</Button>
);

export default function Dashboard() {
  const { ov, meta, ovLoading } = useApp();
  const k = ov.kpis as Record<string, number>;
  const critical = ov.warnings.filter((c) => c.risk === "critical" || c.risk === "stockout");
  return (
    <div className={`space-y-5 transition-opacity ${ovLoading ? "opacity-70" : ""}`}>
      {critical.length > 0 && (
        <div className="rise relative overflow-hidden rounded-2xl border border-red-200 bg-gradient-to-r from-red-50 via-white to-red-50/40 p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-4">
            <span className="relative grid size-11 place-items-center rounded-xl bg-red-600 text-white shadow-lg shadow-red-600/30">
              <Siren size={20} /><i className="pulse-ring absolute inset-0 rounded-xl bg-red-500" />
            </span>
            <div className="min-w-64 flex-1">
              <h2 className="text-sm font-bold text-red-800">Action required · {critical.length} critical stock-out{critical.length === 1 ? "" : "s"} predicted</h2>
              <p className="text-xs leading-5 text-red-900/70">
                {critical.slice(0, 3).map((c) => `${c.hospital} ${c.medicine} (${c.days_to_stockout ?? "60+"} d, lead ${c.lead_days} d)`).join(" · ")}
                {critical.length > 3 && ` · +${critical.length - 3} more`}. An order placed today arrives too late. Review the redistribution plan.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="danger-solid" onClick={() => go("/redistribution")}>Resolve with plan</Button>
              <Button variant="secondary" onClick={() => go("/shortage")}>See details</Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Hospitals at risk" value={<AnimatedNumber value={k.hospitals_at_risk} />} icon={<Building2 size={16} />} tone="red" sub={`${k.cells_at_risk} hospital-medicine pairs`} />
        <Stat label="Outbreak signals" value={<AnimatedNumber value={k.spikes} />} icon={<Waves size={16} />} tone="amber" sub="demand spikes detected" delay={50} />
        <Stat label="Projected waste" value={<AnimatedNumber value={k.waste_value} format={inr} />} icon={<PackageX size={16} />} tone="amber" sub={`${fmt(k.waste_units)} units expiring unused`} delay={100} />
        <Stat label="Planned transfers" value={<AnimatedNumber value={k.moves} />} icon={<Truck size={16} />} tone="brand" sub={`${fmt(k.units_moved)} units`} delay={150} />
        <Stat label="Unmet doses (14 d)" value={<span className="text-xl whitespace-nowrap"><AnimatedNumber value={k.unmet_without} /> → <AnimatedNumber value={k.unmet_with} /></span>} icon={<Boxes size={16} />} tone="green" sub="without → with system" delay={200} />
        <Stat label="Plan verified" value={ov.kpis.plan_verified ? "✓ All" : "✗ Failed"} icon={<ShieldCheck size={16} />} tone={ov.kpis.plan_verified ? "green" : "red"} sub="numbers add up" delay={250} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Network inventory" icon={<Boxes size={18} />} subtitle="Stock · days of cover · colour = risk" actions={<>{more("/inventory")}</>}>
          <InventoryGrid compact />
          <div className="mt-3"><RiskLegend /></div>
        </Card>
        <DemandPanel compact />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Shortage risk" icon={<Siren size={18} />} subtitle="Days until stock-out vs supplier lead time" actions={more("/shortage")}>
          <ShortageList limit={3} />
        </Card>
        <Card title="Expiry & wastage" icon={<PackageX size={18} />} subtitle="Batches that will expire unused" actions={more("/expiry")}>
          <ExpiryList limit={2} />
        </Card>
      </div>

      <Card title="Redistribution engine" icon={<Share2 size={18} />} subtitle="Optimiser-proposed transfers between hospitals" actions={more("/redistribution", "Open engine")}>
        <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
          <NetworkMap meta={meta} ov={ov} moves={ov.plan.moves} filterMed="ALL" onHospital={(h) => go(`/hospitals/${h}`)} />
          <div className="space-y-3">
            <MoveCards filter="ALL" limit={3} />
            <p className="text-xs text-muted">{ov.plan.moves.length} transfers proposed · {ov.verification.passed ? "all verification checks passed" : "verification failed"}.</p>
          </div>
        </div>
      </Card>

      <AssistantPanel compact />
    </div>
  );
}
