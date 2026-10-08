import { useId, useState } from "react";
import type { Cell, Hospital, Meta, Move, Overview } from "../api";
import { RISK, RISK_RANK, fmt } from "./ui";

export const C = {
  brand: "#3b5bdb", teal: "#0d9488", red: "#dc2626", amber: "#ca8a04", green: "#16a34a", slate: "#94a3b8", ink: "#0f172a",
  orange: "#ea580c", violet: "#7c3aed", pink: "#fca5a5",
};

type Entry = { name?: string | number; value?: unknown; color?: string; stroke?: string; fill?: string; dataKey?: string | number };

/** Glass tooltip used by every chart. */
export function ChartTooltip({ active, payload, label, suffix = "" }: {
  active?: boolean; payload?: readonly Entry[]; label?: string | number; suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined && p.name !== undefined);
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-white/60 bg-white/90 px-3 py-2 text-xs shadow-xl ring-1 ring-black/5 backdrop-blur">
      <div className="mb-1 font-semibold text-ink">{label}</div>
      {rows.map((p, i) => {
        const v = Array.isArray(p.value) ? `${fmt(Number(p.value[0]))} – ${fmt(Number(p.value[1]))}` : fmt(Number(p.value), 1);
        const color = p.color ?? p.stroke ?? p.fill ?? C.slate;
        return (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <i className="size-2 rounded-full" style={{ background: color }} />
            <span className="text-muted">{p.name}</span>
            <b className="num ml-auto pl-3 text-ink">{v}{suffix}</b>
          </div>
        );
      })}
    </div>
  );
}

export const AXIS = { fontSize: 11, fill: "#64748b" };
export const GRID = "#eaeef6";

/* ----------------------------------------------------------- Network map */
function layout(hs: Hospital[], W: number, H: number, pad = 60, padX = 150) {
  const lons = hs.map((h) => h.lon), lats = hs.map((h) => h.lat);
  const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const pts = hs.map((h) => ({ id: h.id, x: padX + ((h.lon - x0) / (x1 - x0 || 1)) * (W - 2 * padX), y: pad + ((y1 - h.lat) / (y1 - y0 || 1)) * (H - 2 * pad) }));
  for (let it = 0; it < 120; it++) {               // push apart hospitals that sit in the same city
    for (const a of pts) for (const b of pts) {
      if (a === b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (d < 124) { const p = (124 - d) / 4; a.x -= (dx / d) * p; a.y -= (dy / d) * p; b.x += (dx / d) * p; b.y += (dy / d) * p; }
    }
  }
  for (const p of pts) { p.x = Math.min(W - padX, Math.max(padX, p.x)); p.y = Math.min(H - pad, Math.max(pad, p.y)); }
  return Object.fromEntries(pts.map((p) => [p.id, p]));
}

const short = (n: string) => n.replace(/^Government /, "Govt ").replace(/ & Research Centre/, "").replace(/ Hospital$/, "").replace(/ Medical College/, " MC").replace(/ District| Taluk/, "").slice(0, 24);

export function NetworkMap({ meta, ov, moves, filterMed, onHospital, focusKey = null }: {
  meta: Meta; ov: Overview; moves: Move[]; filterMed: string; onHospital: (h: string) => void; focusKey?: string | null;
}) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<string | null>(null);
  const W = 680, Hh = 460;
  const P = layout(meta.hospitals, W, Hh);
  const max = Math.max(1, ...moves.map((mv) => mv.qty));
  const worst = (h: string) => ov.cells.filter((c) => c.hospital === h && (filterMed === "ALL" || c.medicine === filterMed))
    .reduce((r, c) => (RISK_RANK[c.risk] < RISK_RANK[r] ? c.risk : r), "ok" as Cell["risk"]);
  const colorOf = (k: Move["kind"]) => (k === "need" ? C.brand : k === "emergency" ? C.orange : C.teal);

  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} className="h-auto w-full rounded-2xl border border-line bg-gradient-to-br from-slate-50 to-indigo-50/40">
      <defs>
        <pattern id={`dots-${uid}`} width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="#d5dcec" /></pattern>
        <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <filter id={`shadow-${uid}`} x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#1e293b" floodOpacity="0.22" /></filter>
        {(["need", "rescue", "emergency"] as const).map((k) => (
          <marker key={k} id={`arrow-${k}-${uid}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="15" markerHeight="15" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M1,1 L11,6 L1,11 L3.5,6 z" fill={colorOf(k)} />
          </marker>
        ))}
        {moves.map((mv, i) => {
          const a = P[mv.from], b = P[mv.to];
          return (
            <linearGradient key={mv.id} id={`g-${uid}-${i}`} gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
              <stop offset="0" stopColor={colorOf(mv.kind)} stopOpacity="0.25" /><stop offset="1" stopColor={colorOf(mv.kind)} stopOpacity="1" />
            </linearGradient>
          );
        })}
      </defs>
      <rect width={W} height={Hh} fill={`url(#dots-${uid})`} rx="16" />

      {moves.map((mv, i) => {
        const a = P[mv.from], b = P[mv.to];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const r = 26;
        const sx = a.x + (dx / d) * r, sy = a.y + (dy / d) * r, ex = b.x - (dx / d) * (r + 5), ey = b.y - (dy / d) * (r + 5);
        const side = mv.from < mv.to ? 1 : -1;
        const bend = side * (30 + (i % 3) * 16);
        const cx = (sx + ex) / 2 - (dy / d) * bend, cy = (sy + ey) / 2 + (dx / d) * bend;
        const mx = 0.25 * sx + 0.5 * cx + 0.25 * ex, my = 0.25 * sy + 0.5 * cy + 0.25 * ey;
        const path = `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`;
        const width = 2 + (mv.qty / max) * 5;
        const label = `${fmt(mv.qty)}${filterMed === "ALL" ? ` ${mv.medicine}` : ""}`;
        const dim = (hover !== null && hover !== mv.from && hover !== mv.to) || (focusKey !== null && focusKey !== mv.key);
        const color = colorOf(mv.kind);
        return (
          <g key={mv.id} opacity={dim ? 0.12 : 1} style={{ transition: "opacity 180ms" }}>
            <title>{mv.text}</title>
            <path d={path} fill="none" stroke={color} strokeOpacity={0.14} strokeWidth={width + 8} strokeLinecap="round" />
            <path d={path} fill="none" stroke={`url(#g-${uid}-${i})`} strokeWidth={width} strokeLinecap="round" className="flow"
              markerEnd={`url(#arrow-${mv.kind}-${uid})`} />
            {!dim && (
              <circle r={3.4} fill="#fff" stroke={color} strokeWidth={1.6} filter={`url(#glow-${uid})`}>
                <animateMotion dur={`${2.4 + (i % 4) * 0.5}s`} repeatCount="indefinite" path={path} />
              </circle>
            )}
            <g transform={`translate(${mx},${my})`}>
              <rect x={-(label.length * 3.2 + 9)} y={-10} width={label.length * 6.4 + 18} height={20} rx={10} fill="#fff" stroke={color} strokeWidth={1.2} filter={`url(#shadow-${uid})`} />
              <text textAnchor="middle" y={4} fontSize="10.5" fontWeight={700} fill={color}>{label}</text>
            </g>
          </g>
        );
      })}

      {meta.hospitals.map((h) => {
        const p = P[h.id], rk = worst(h.id), hot = rk === "critical" || rk === "stockout";
        const active = hover === h.id;
        const near = Object.values(P).filter((q) => q.id !== h.id && Math.hypot(q.x - p.x, q.y - p.y) < 135)
          .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
        const side = near ? (p.x >= near.x ? 1 : -1) : 0;
        return (
          <g key={h.id} className="cursor-pointer" onClick={() => onHospital(h.id)}
            onMouseEnter={() => setHover(h.id)} onMouseLeave={() => setHover(null)}>
            <title>{`${h.name} · ${RISK[rk].label}`}</title>
            {hot && <circle cx={p.x} cy={p.y} r={24} fill={RISK[rk].color} className="pulse-ring" />}
            <circle cx={p.x} cy={p.y} r={active ? 31 : 28} fill={RISK[rk].color} fillOpacity={0.12} style={{ transition: "r 160ms" }} />
            <circle cx={p.x} cy={p.y} r={22} fill="#fff" stroke={RISK[rk].color} strokeWidth={3} filter={`url(#shadow-${uid})`} />
            <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize="15" fontWeight={800} fill={C.ink}>{h.id}</text>
            <g transform={side === 0 ? `translate(${p.x},${p.y + 40})` : `translate(${p.x + side * 32},${p.y - 2})`}>
              <text textAnchor={side === 0 ? "middle" : side > 0 ? "start" : "end"} fontSize="10.5" fontWeight={600} fill="#334155" paintOrder="stroke" stroke="#f8fafc" strokeWidth={4}>{short(h.name)}</text>
              <text textAnchor={side === 0 ? "middle" : side > 0 ? "start" : "end"} y={12} fontSize="9.5" fill="#64748b" paintOrder="stroke" stroke="#f8fafc" strokeWidth={4}>{h.city}</text>
            </g>
          </g>
        );
      })}

      <g transform={`translate(16,${Hh - 22})`} fontSize="10.5" fill="#475569" fontWeight={600}>
        <rect x={-6} y={-14} width={390} height={24} rx={12} fill="#fff" fillOpacity={0.9} stroke="#e2e8f0" />
        <line x1={6} y1={-2} x2={30} y2={-2} stroke={C.brand} strokeWidth={3} strokeLinecap="round" />
        <text x={38} y={2}>Shortage transfer</text>
        <line x1={140} y1={-2} x2={164} y2={-2} stroke={C.teal} strokeWidth={3} strokeLinecap="round" />
        <text x={172} y={2}>Expiry rescue</text>
        <line x1={262} y1={-2} x2={286} y2={-2} stroke={C.orange} strokeWidth={3} strokeLinecap="round" />
        <text x={294} y={2}>Emergency loan</text>
      </g>
    </svg>
  );
}
