import { useEffect, useId, useRef } from "react";
import type { Meta, Overview, Shipment, Transfer } from "../api";
import { go } from "../router";
import { C, NetworkMap, type MapCtx } from "./charts";
import { fmt } from "./ui";

type Pt = { x: number; y: number };
type Line = { pts: Pt[]; cum: number[]; total: number };
type Active = Transfer & { shipment: Shipment };
export type RoadPaths = Record<string, [number, number][]>;

const ACTIVE = ["planned", "requested", "assigned", "in_transit", "arrived"];

const colorOf = (s: Shipment) =>
  s.status === "requested" ? C.amber : s.at_door || s.status === "arrived" ? C.green : s.status === "in_transit" ? (s.delayed ? C.red : C.teal) : C.brand;

/* ------------------------------------------------------------------ geometry along a road */
const toLine = (pts: Pt[]): Line => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, total: cum[cum.length - 1] };
};

/** The point `d` pixels along the road. */
function at(l: Line, d: number): Pt {
  const t = Math.max(0, Math.min(l.total, d));
  let lo = 0, hi = l.pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (l.cum[m] <= t) lo = m; else hi = m; }
  const seg = l.cum[hi] - l.cum[lo] || 1, k = (t - l.cum[lo]) / seg;
  return { x: l.pts[lo].x + (l.pts[hi].x - l.pts[lo].x) * k, y: l.pts[lo].y + (l.pts[hi].y - l.pts[lo].y) * k };
}

/** Cut `a` px off the start and `b` px off the end so the route begins and ends at the edge of the hospital markers. */
function trim(pts: Pt[], a: number, b: number): Line {
  const full = toLine(pts);
  if (full.total < a + b + 6) return full;
  const mid = full.pts.filter((_, i) => full.cum[i] > a && full.cum[i] < full.total - b);
  return toLine([at(full, a), ...mid, at(full, full.total - b)]);
}

const dPath = (l: Line) => l.pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

/* ------------------------------------------------------------------ the truck */
/** A Scania-style tractor (tall sleeper cab, flat front, grille and headlight) pulling a white medical-supply trailer. Faces right. */
function TruckArt({ color, uid }: { color: string; uid: string }) {
  const wheel = (cx: number) => (
    <g key={cx}>
      <circle cx={cx} cy={5.4} r={3.3} fill="#0f172a" stroke="#f8fafc" strokeWidth={0.5} />
      <circle cx={cx} cy={5.4} r={1.8} fill="#cbd5e1" />
      <circle cx={cx} cy={5.4} r={0.7} fill="#475569" />
    </g>
  );
  const cab = "M7.2,3.2 V-7.6 Q7.2,-8.8 8.4,-8.8 H13 Q13.9,-8.8 14.4,-8.1 L17.6,-3.4 Q18.1,-2.6 18.1,-1.7 V3.2 Z";
  return (
    <g>
      <defs>
        <linearGradient id={`shade-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.38" /><stop offset="0.55" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="0.28" />
        </linearGradient>
        <linearGradient id={`box-${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#dbe3ee" /></linearGradient>
      </defs>
      <ellipse cx={-1} cy={7.9} rx={21.5} ry={1.8} fill="#0f172a" opacity={0.2} />
      <rect x={-20} y={3} width={40} height={2.6} rx={1} fill="#334155" />
      <rect x={2.5} y={4.4} width={6} height={2.6} rx={1.2} fill="#94a3b8" stroke="#64748b" strokeWidth={0.5} />
      <rect x={6} y={-10.6} width={1} height={8} rx={0.5} fill="#cbd5e1" stroke="#94a3b8" strokeWidth={0.3} />

      <rect x={-20.5} y={-9.8} width={26.5} height={12.8} rx={1.4} fill={`url(#box-${uid})`} stroke="#94a3b8" strokeWidth={0.7} />
      {[-15, -10, -5, 0].map((x) => <path key={x} d={`M${x},-9.4 V2.6`} stroke="#94a3b8" strokeOpacity={0.45} strokeWidth={0.45} />)}
      <rect x={-20.5} y={-0.7} width={26.5} height={2.6} fill={color} />
      <g transform="translate(-9 -5.2)">
        <rect x={-1.1} y={-3.2} width={2.2} height={6.4} rx={0.6} fill={color} />
        <rect x={-3.2} y={-1.1} width={6.4} height={2.2} rx={0.6} fill={color} />
      </g>
      <rect x={-21.3} y={1.6} width={1.6} height={2.2} rx={0.4} fill="#475569" />
      <rect x={5.4} y={2.2} width={2.6} height={1} fill="#1e293b" />

      <path d="M8,-8.8 L8,-11 Q8,-11.5 8.6,-11.2 L12.9,-9.3 V-8.8 Z" fill={color} stroke="#0f172a" strokeOpacity={0.35} strokeWidth={0.4} />
      <path d={cab} fill={color} stroke="#0f172a" strokeOpacity={0.45} strokeWidth={0.6} strokeLinejoin="round" />
      <path d={cab} fill={`url(#shade-${uid})`} />
      <path d="M9.1,-7.4 H12.7 L15.7,-3.3 H9.1 Z" fill="#cfe5ff" stroke="#0f172a" strokeOpacity={0.5} strokeWidth={0.6} strokeLinejoin="round" />
      <path d="M10,-7.4 H11.2 L9.9,-3.3 H9.1 V-5 Z" fill="#fff" opacity={0.55} />
      <path d="M12.6,-2.6 V3" stroke="#0f172a" strokeOpacity={0.35} strokeWidth={0.5} />
      <rect x={9.6} y={-1.9} width={2} height={0.8} rx={0.4} fill="#e2e8f0" />
      <path d="M7.4,0.9 H17.9" stroke="#fff" strokeOpacity={0.8} strokeWidth={1.1} />
      <rect x={17.1} y={-1.3} width={1.4} height={4.1} rx={0.3} fill="#0f172a" />
      <path d="M17.2,-0.2 H18.5 M17.2,0.9 H18.5 M17.2,2 H18.5" stroke="#94a3b8" strokeWidth={0.35} />
      <rect x={17.3} y={-2.6} width={1.3} height={1.5} rx={0.4} fill="#fef9c3" stroke="#facc15" strokeWidth={0.35} />
      <rect x={16.8} y={2.7} width={2.8} height={1.5} rx={0.6} fill="#475569" />
      <rect x={15.5} y={-3.1} width={1.1} height={2.3} rx={0.5} fill="#1e293b" />
      {[-14, -8.2, 13.6].map(wheel)}
    </g>
  );
}

/** Positions itself every frame from the server's progress and time-left, so it keeps rolling between refreshes. */
function Truck({ line, s, color, scale, onSettled }: { line: Line; s: Shipment; color: string; scale: number; onSettled: () => void }) {
  const uid = useId().replace(/:/g, "");
  const outer = useRef<SVGGElement>(null), inner = useRef<SVGGElement>(null), txt = useRef<SVGTextElement>(null);
  const lineRef = useRef(line), sRef = useRef(s), cb = useRef(onSettled), scaleRef = useRef(scale);
  lineRef.current = line; sRef.current = s; cb.current = onSettled; scaleRef.current = scale;
  const t0 = useRef(performance.now()), settled = useRef(true), facing = useRef(1);

  useEffect(() => {                                   // a fresh figure from the server: restart the clock from it
    t0.current = performance.now();
    settled.current = !(s.status === "in_transit" && !s.at_door);
  }, [s.id, s.progress, s.remaining_seconds, s.status, s.at_door]);

  useEffect(() => {
    let raf = 0;
    const frame = (now: number) => {
      const sh = sRef.current, l = lineRef.current, k = scaleRef.current;
      const moving = sh.status === "in_transit" && !sh.at_door && sh.remaining_seconds !== null;
      let p = 0, left = 0;
      if (moving) {
        const dt = (now - t0.current) / 1000, rem = sh.remaining_seconds as number;
        p = sh.progress + (1 - sh.progress) * (rem > 0 ? Math.min(1, dt / rem) : 1);
        left = Math.max(0, rem - dt);
      } else if (sh.at_door || sh.status === "arrived" || sh.status === "delivered") p = 1;
      const d = p * l.total, here = at(l, d), a = at(l, d - 7), b = at(l, d + 7);
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) > 0.2) facing.current = dx > 0 ? 1 : -1;      // keep the last side on near-vertical stretches
      const ang = Math.atan2(facing.current > 0 ? dy : -dy, Math.abs(dx) < 0.2 ? 0.2 : Math.abs(dx)) * 180 / Math.PI;
      const tilt = Math.max(-55, Math.min(55, ang));
      outer.current?.setAttribute("transform", `translate(${here.x.toFixed(1)} ${here.y.toFixed(1)})`);
      inner.current?.setAttribute("transform", `rotate(${(facing.current > 0 ? tilt : -tilt).toFixed(1)}) scale(${facing.current * k} ${k})`);
      if (txt.current) txt.current.textContent = moving ? `${Math.ceil(left)}s` : "";
      if (moving && p >= 1 && !settled.current) { settled.current = true; cb.current(); }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <g ref={outer} pointerEvents="none" data-truck={s.transfer_id}>
      <g ref={inner}><TruckArt color={color} uid={uid} /></g>
      <text ref={txt} y={-17 * scale - 4} textAnchor="middle" fontSize={10.5} fontWeight={800} fill={color} paintOrder="stroke" stroke="#fff" strokeWidth={3.5} />
    </g>
  );
}

/* ------------------------------------------------------------------ routes */
function Routes({ ctx, items, paths, selectedId, onSelect, onSettled }: {
  ctx: MapCtx; items: Active[]; paths: RoadPaths; selectedId: number | null; onSelect: (id: number) => void; onSettled: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const { P, R, H, project } = ctx;
  const scale = Math.max(1.0, Math.min(1.7, (R / 10) * 1.1));
  const kinds = [["brand", C.brand], ["amber", C.amber], ["teal", C.teal], ["red", C.red], ["green", C.green]] as const;

  /** The road from donor to recipient, projected into the current view and trimmed to the markers. */
  const roadFor = (t: Active): Line | null => {
    const a = P[t.from_id], b = P[t.to_id];
    if (!a || !b) return null;
    const key = t.from_id < t.to_id ? `${t.from_id}-${t.to_id}` : `${t.to_id}-${t.from_id}`;
    let ll = paths[key];
    if (ll && t.from_id > t.to_id) ll = [...ll].reverse();
    const pts: Pt[] = ll && ll.length > 1 ? [a, ...ll.map(([lat, lon]) => project(lat, lon)), b] : [a, b];
    return trim(pts, R + 2, R + 8);
  };
  const lines = items.map(roadFor);

  return (
    <g>
      <defs>
        {kinds.map(([k, col]) => (
          <marker key={k} id={`darrow-${k}-${uid}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="15" markerHeight="15" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M1,1 L11,6 L1,11 L3.5,6 z" fill={col} />
          </marker>
        ))}
      </defs>

      {items.map((t, i) => {
        const line = lines[i];
        if (!line) return null;
        const s = t.shipment, col = colorOf(s), key = kinds.find(([, c]) => c === col)![0];
        const on = selectedId === t.id, d = dPath(line), m = at(line, line.total / 2), label = `#${t.id} · ${fmt(t.qty)}`;
        const moving = s.status === "in_transit" && !s.at_door;
        return (
          <g key={t.id} opacity={selectedId === null || on ? 1 : 0.5} style={{ transition: "opacity 180ms" }}>
            <title>{`Transfer #${t.id}: ${fmt(t.qty)} from ${t.from_id} to ${t.to_id} (${s.mode_label})`}</title>
            <path d={d} fill="none" stroke="#fff" strokeOpacity={0.85} strokeWidth={on ? 9 : 7} strokeLinecap="round" strokeLinejoin="round" />
            <path d={d} fill="none" stroke={col} strokeWidth={on ? 4.2 : 3.2} strokeLinecap="round" strokeLinejoin="round" markerEnd={`url(#darrow-${key}-${uid})`}
              strokeDasharray={s.status === "planned" || s.status === "assigned" || s.status === "requested" ? "7 6" : undefined} className={moving ? "flow" : undefined} />
            <path d={d} fill="none" stroke="transparent" strokeWidth={16} pointerEvents="stroke" style={{ cursor: "pointer" }}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSelect(t.id); }} />
            <g transform={`translate(${m.x},${m.y})`} pointerEvents="none">
              <rect x={-(label.length * 3 + 8)} y={-9} width={label.length * 6 + 16} height={18} rx={9} fill="#fff" stroke={col} strokeWidth={on ? 2 : 1.2} />
              <text textAnchor="middle" y={3.6} fontSize="9.5" fontWeight={700} fill={col}>{label}</text>
            </g>
          </g>
        );
      })}

      {items.map((t, i) => {
        const line = lines[i];
        if (!line || t.shipment.status === "requested") return null;      // no vehicle yet, so no truck
        return <Truck key={t.id} line={line} s={t.shipment} color={colorOf(t.shipment)} scale={scale} onSettled={onSettled} />;
      })}

      <g transform={`translate(16,${H - 22})`} fontSize="10" fill="#475569" fontWeight={600} pointerEvents="none">
        <rect x={-6} y={-14} width={470} height={24} rx={12} fill="#fff" fillOpacity={0.92} stroke="#e2e8f0" />
        {[[C.brand, "Arranged", true, 0], [C.amber, "Needs vehicle", true, 84], [C.teal, "On the road", false, 196], [C.red, "Late", false, 294], [C.green, "At the door", false, 350]].map(([col, text, dash, x]) => (
          <g key={text as string} transform={`translate(${x as number},0)`}>
            <line x1={4} y1={-2} x2={22} y2={-2} stroke={col as string} strokeWidth={3} strokeLinecap="round" strokeDasharray={dash ? "5 4" : undefined} />
            <text x={28} y={2}>{text as string}</text>
          </g>
        ))}
      </g>
    </g>
  );
}

/** The OpenStreetMap network map with every hospital, plus an arrowed road route and a truck for each delivery that has been arranged. */
export function DeliveryMap({ meta, ov, transfers, paths, selectedId, onSelect, onSettled, zoomToSelected = false }: {
  meta: Meta; ov: Overview; transfers: Transfer[]; paths: RoadPaths; selectedId: number | null; onSelect: (id: number) => void; onSettled: () => void;
  zoomToSelected?: boolean;
}) {
  const sel = zoomToSelected ? transfers.find((t) => t.id === selectedId) : null;
  const items = transfers.filter((t): t is Active => !!t.shipment && ACTIVE.includes(t.shipment.status) && t.status !== "cancelled" && t.status !== "delivered")
    .sort((a, b) => a.id - b.id);
  return (
    <NetworkMap meta={meta} ov={ov} moves={[]} filterMed="ALL" legend={false} wheelZoom={false} focusIds={sel ? [sel.from_id, sel.to_id] : null}
      onHospital={(h) => go(`/hospitals/${h}`)}
      overlay={(ctx) => <Routes ctx={ctx} items={items} paths={paths} selectedId={selectedId} onSelect={onSelect} onSettled={onSettled} />} />
  );
}
