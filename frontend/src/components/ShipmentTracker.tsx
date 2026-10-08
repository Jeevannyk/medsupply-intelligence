import { useEffect, useRef, useState } from "react";
import { CircleAlert, KeyRound, MapPin, Truck } from "lucide-react";
import type { Shipment } from "../api";
import { Pill, fmtLeft } from "./ui";

const TONE: Record<Shipment["status"], "amber" | "brand" | "teal" | "green" | "red" | "slate"> = {
  planned: "slate", requested: "amber", assigned: "brand", in_transit: "teal", arrived: "green", delivered: "green", cancelled: "red",
};
const LABEL: Record<Shipment["status"], string> = {
  planned: "Delivery arranged", requested: "Waiting for a district vehicle", assigned: "Vehicle assigned", in_transit: "On the road",
  arrived: "At the door, awaiting confirmation", delivered: "Delivered", cancelled: "Cancelled",
};
const hm = (iso: string | null) => (iso ? iso.slice(11, 16) : "–");
const hms = (iso: string | null) => (iso ? iso.slice(11, 19) : "–");

/** Progress and time left, advancing smoothly between data refreshes (the server figure is the starting point). */
export function useLiveProgress(s: Shipment): { p: number; left: number | null } {
  const [, tick] = useState(0);
  const t0 = useRef(Date.now());
  const running = s.status === "in_transit" && !s.at_door && s.remaining_seconds !== null;
  useEffect(() => { t0.current = Date.now(); }, [s.id, s.progress, s.remaining_seconds, s.status]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [running, s.id]);
  if (!running) return { p: s.at_door || s.status === "arrived" || s.status === "delivered" ? 1 : s.progress, left: s.status === "in_transit" ? 0 : null };
  const rem = s.remaining_seconds as number;
  const dt = (Date.now() - t0.current) / 1000;
  return { p: Math.min(1, s.progress + (1 - s.progress) * (rem > 0 ? Math.min(1, dt / rem) : 1)), left: Math.max(0, rem - dt) };
}

export function carrierLine(s: Shipment) {
  if (s.mode === "courier") return `${s.carrier ?? "Courier"} · tracking ${s.tracking_id ?? "–"}`;
  return s.vehicle ? `${s.vehicle}${s.driver ? ` · driver ${s.driver}` : ""}` : "No vehicle yet";
}

export function ShipmentTracker({ s, showCode = false }: { s: Shipment; showCode?: boolean }) {
  const [trail, setTrail] = useState(false);
  const live = s.status === "in_transit";
  const late = !!s.delayed && live && !s.at_door;
  const { p, left } = useLiveProgress(s);
  return (
    <div className={`rounded-xl border p-3 text-xs ${late ? "border-red-300 bg-red-50/60" : "border-line bg-slate-50/70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Truck size={14} className="text-muted" />
        <Pill tone="brand">{s.mode_label}</Pill>
        <Pill tone={late ? "red" : s.at_door && live ? "green" : TONE[s.status]}>{late ? "Delayed" : s.at_door && live ? LABEL.arrived : LABEL[s.status]}</Pill>
        {s.cold_chain ? <Pill tone="teal">Cold chain</Pill> : null}
        {s.eta_at && live && (
          <span className="num ml-auto font-semibold text-ink">ETA {hms(s.eta_at)} · {fmtLeft(left)}</span>
        )}
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-muted"><MapPin size={12} />{carrierLine(s)}</p>
      {(live || s.status === "arrived") && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${late ? "bg-red-500" : "bg-teal-500"}`} style={{ width: `${Math.max(4, p * 100)}%` }} />
        </div>
      )}
      {late && <p className="mt-2 flex items-start gap-1 font-medium text-red-800"><CircleAlert size={13} className="mt-0.5 shrink-0" />Running late. The planner now expects this stock later, so the recipient's risk and the plan have been recalculated.</p>}
      {showCode && s.handover_code && (
        <p className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-brand/30">
          <KeyRound size={14} className="text-brand" />Handover code
          <b className="num text-base tracking-[0.2em] text-ink">{s.handover_code}</b>
          <span className="text-muted">Give it to the driver. The receiver needs it to confirm.</span>
        </p>
      )}
      {s.status === "delivered" && s.condition && s.condition !== "ok" && (
        <p className="mt-2 font-medium text-amber-800">{s.received_qty?.toLocaleString("en-US")} units accepted, the rest {s.condition === "damaged" ? "written off as damaged" : "short and returned to the donor"}.</p>
      )}
      {s.events.length > 0 && (
        <>
          <button className="mt-2 text-[11px] font-semibold text-brand-ink hover:underline" onClick={() => setTrail(!trail)}>{trail ? "Hide" : "Show"} event trail ({s.events.length})</button>
          {trail && (
            <ol className="mt-1.5 space-y-1 border-l-2 border-line pl-3">
              {s.events.map((e) => (
                <li key={e.id}><span className="num text-muted">{hm(e.ts)}</span> <b>{e.type.replace("_", " ")}</b> <span className="text-muted">({e.source})</span>{e.note ? ` · ${e.note}` : ""}</li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
