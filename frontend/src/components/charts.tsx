import { useEffect, useId, useRef, useState } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
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
/* Real OpenStreetMap tiles (Web-Mercator) with hospitals at their true lat/lon. The view is zoomable (wheel, +/-, drag to pan);
   tile level and node size follow the zoom so the map stays sharp and nodes stay readable. */
const TS = 256;
const ZMAX = 17;
const ux = (lon: number) => (lon + 180) / 360;                 // world coordinates, 0..1
const uy = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const TILES = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type View = { z: number; cx: number; cy: number };            // fractional zoom + world-coordinate centre

function fitView(hs: Hospital[], W: number, H: number, pad = 50, padX = 90): View {
  const xs = hs.map((h) => ux(h.lon)), ys = hs.map((h) => uy(h.lat));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const S = Math.min((W - 2 * padX) / (x1 - x0 || 1e-6), (H - 2 * pad) / (y1 - y0 || 1e-6));
  return { z: clamp(Math.log2(S / TS), 0, ZMAX), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** Keeps the world point under (px, py) fixed while changing zoom. */
function zoomAt(v: View, px: number, py: number, nz: number, W: number, H: number, zMin: number): View {
  const z = clamp(nz, zMin, ZMAX), S = TS * 2 ** v.z, S2 = TS * 2 ** z;
  return { z, cx: v.cx + (px - W / 2) / S - (px - W / 2) / S2, cy: v.cy + (py - H / 2) / S - (py - H / 2) / S2 };
}

type Tile = { key: string; url: string; x: number; y: number; size: number };
function tilesAt(v: View, W: number, H: number, zt: number): Tile[] {
  const S = TS * 2 ** v.z, n = 2 ** zt, size = S / n;
  const out: Tile[] = [];
  for (let ty = Math.max(0, Math.floor((v.cy - H / 2 / S) * n)); ty <= Math.min(n - 1, Math.floor((v.cy + H / 2 / S) * n)); ty++)
    for (let tx = Math.max(0, Math.floor((v.cx - W / 2 / S) * n)); tx <= Math.min(n - 1, Math.floor((v.cx + W / 2 / S) * n)); tx++)
      out.push({ key: `${zt}-${tx}-${ty}`, url: TILES(zt, tx, ty), x: (tx / n - v.cx) * S + W / 2, y: (ty / n - v.cy) * S + H / 2, size: size + 0.6 });
  return out;
}

const short = (n: string) => n.replace(/^Government /, "Govt ").replace(/ & Research Centre/, "").replace(/ Hospital$/, "").replace(/ Medical College/, " MC").replace(/ District| Taluk/, "").slice(0, 24);

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Puts each hospital's name on the side (right, left, above, below) where it collides least with nodes, other labels, the legend and the credit. */
function placeLabels(hs: Hospital[], P: Record<string, { x: number; y: number }>, W: number, H: number, R: number) {
  const taken: Box[] = [{ x0: 8, y0: H - 40, x1: 410, y1: H - 8 }, { x0: W - 172, y0: 2, x1: W, y1: 26 }, { x0: 6, y0: 6, x1: 46, y1: 112 }];   // legend, credit, zoom buttons
  const discs = (skip: string): Box[] => hs.filter((h) => h.id !== skip).map((h) => ({ x0: P[h.id].x - R - 3, y0: P[h.id].y - R - 3, x1: P[h.id].x + R + 3, y1: P[h.id].y + R + 3 }));
  const crowd = (h: Hospital) => hs.filter((o) => o.id !== h.id && Math.hypot(P[o.id].x - P[h.id].x, P[o.id].y - P[h.id].y) < 60).length;
  const out: Record<string, { x: number; y: number; anchor: "start" | "end" | "middle" }> = {};
  for (const h of [...hs].sort((a, b) => crowd(b) - crowd(a))) {
    const p = P[h.id], w = Math.max(short(h.name).length * 5.4, h.city.length * 4.8) + 4, others = discs(h.id);
    const cands = [
      { x: p.x + R + 6, y: p.y - 1, anchor: "start" as const, box: { x0: p.x + R + 4, x1: p.x + R + 8 + w, y0: p.y - 12, y1: p.y + 13 } },
      { x: p.x - R - 6, y: p.y - 1, anchor: "end" as const, box: { x0: p.x - R - 8 - w, x1: p.x - R - 4, y0: p.y - 12, y1: p.y + 13 } },
      { x: p.x, y: p.y - R - 17, anchor: "middle" as const, box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - R - 28, y1: p.y - R - 3 } },
      { x: p.x, y: p.y + R + 14, anchor: "middle" as const, box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y + R + 3, y1: p.y + R + 28 } },
    ];
    const cost = (b: Box) => [...others, ...taken].reduce((s, o) => s + overlap(b, o), 0)
      + 3 * ((b.x1 - b.x0) * (b.y1 - b.y0) - overlap(b, { x0: 0, y0: 0, x1: W, y1: H }));
    const best = cands.reduce((a, c) => (cost(c.box) < cost(a.box) ? c : a));
    taken.push(best.box);
    out[h.id] = { x: best.x, y: best.y, anchor: best.anchor };
  }
  return out;
}

export function NetworkMap({ meta, ov, moves, filterMed, onHospital, focusKey = null }: {
  meta: Meta; ov: Overview; moves: Move[]; filterMed: string; onHospital: (h: string) => void; focusKey?: string | null;
}) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 680, Hh = 460;

  const fit = fitView(meta.hospitals, W, Hh);
  const zMin = Math.max(0, fit.z - 1);
  const [view, setView] = useState<View | null>(null);
  const v = view ?? fit;
  const viewRef = useRef(v), fitRef = useRef(fit), raf = useRef(0);
  viewRef.current = v;
  fitRef.current = fit;
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  const animateTo = (t: View, ms = 260) => {
    cancelAnimationFrame(raf.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setView(t); return; }
    const f = viewRef.current, t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - (1 - p) ** 3;
      setView({ z: f.z + (t.z - f.z) * e, cx: f.cx + (t.cx - f.cx) * e, cy: f.cy + (t.cy - f.cy) * e });
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const toSvg = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((cx - r.left) * W) / r.width, y: ((cy - r.top) * Hh) / r.height, k: W / r.width };
  };

  // wheel zoom needs a non-passive listener so the page does not scroll while zooming the map
  useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(raf.current);
      const r = el.getBoundingClientRect();
      const px = ((e.clientX - r.left) * W) / r.width, py = ((e.clientY - r.top) * Hh) / r.height;
      const cur = viewRef.current, zm = Math.max(0, fitRef.current.z - 1);
      setView(zoomAt(cur, px, py, cur.z - e.deltaY * 0.0022, W, Hh, zm));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); cancelAnimationFrame(raf.current); };
  }, []);

  // projection of the current view
  const S = TS * 2 ** v.z, S0 = TS * 2 ** fit.z;
  const P: Record<string, { id: string; x: number; y: number }> = Object.fromEntries(
    meta.hospitals.map((h) => [h.id, { id: h.id, x: (ux(h.lon) - v.cx) * S + W / 2, y: (uy(h.lat) - v.cy) * S + Hh / 2 }]));
  const R = clamp(10 * (S / S0) ** 0.4, 5, 18);                  // node size follows zoom: smaller zoomed out, larger zoomed in
  const zt = clamp(Math.round(v.z), 0, 19);
  const tiles = [...(zt > 3 ? tilesAt(v, W, Hh, zt - 1) : []), ...tilesAt(v, W, Hh, zt)];   // parent level underneath hides blank tiles while loading
  const visible = meta.hospitals.filter((h) => P[h.id].x > -40 && P[h.id].x < W + 40 && P[h.id].y > -40 && P[h.id].y < Hh + 40);
  const labels = placeLabels(visible, P, W, Hh, R);

  // hospitals can sit a few metres apart, so pick the one nearest the cursor rather than the topmost circle
  const nearest = (cx: number, cy: number) => {
    const { x, y } = toSvg(cx, cy);
    let best: string | null = null, bd = (R + 7) ** 2;
    for (const h of visible) { const d = (P[h.id].x - x) ** 2 + (P[h.id].y - y) ** 2; if (d < bd) { bd = d; best = h.id; } }
    return best;
  };

  const max = Math.max(1, ...moves.map((mv) => mv.qty));
  const worst = (h: string) => ov.cells.filter((c) => c.hospital === h && (filterMed === "ALL" || c.medicine === filterMed))
    .reduce((r, c) => (RISK_RANK[c.risk] < RISK_RANK[r] ? c.risk : r), "ok" as Cell["risk"]);
  const colorOf = (k: Move["kind"]) => (k === "need" ? C.brand : k === "emergency" ? C.orange : C.teal);
  // overlapping nodes: the riskiest (and the hovered one) are drawn on top
  const drawOrder = [...visible].sort((a, b) => (a.id === hover ? 1 : 0) - (b.id === hover ? 1 : 0) || RISK_RANK[worst(b.id)] - RISK_RANK[worst(a.id)]);
  const zoomBy = (dz: number) => animateTo(zoomAt(viewRef.current, W / 2, Hh / 2, viewRef.current.z + dz, W, Hh, zMin));
  const atMin = v.z <= zMin + 0.01, atMax = v.z >= ZMAX - 0.01;

  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${Hh}`} className="h-auto w-full touch-none rounded-2xl border border-line bg-gradient-to-br from-slate-50 to-indigo-50/40 select-none"
        style={{ cursor: drag.current?.moved ? "grabbing" : hover ? "pointer" : "grab" }}
        onPointerDown={(e) => { cancelAnimationFrame(raf.current); drag.current = { x: e.clientX, y: e.clientY, cx: viewRef.current.cx, cy: viewRef.current.cy, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && e.buttons) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) > 4) { d.moved = true; svgRef.current!.setPointerCapture(e.pointerId); }
            if (d.moved) {
              const k = toSvg(0, 0).k, cur = viewRef.current, s = TS * 2 ** cur.z;
              setView({ ...cur, cx: d.cx - (dx * k) / s, cy: d.cy - (dy * k) / s });
              if (hover) setHover(null);
              return;
            }
          }
          const n = nearest(e.clientX, e.clientY);
          if (n !== hover) setHover(n);
        }}
        onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => { if (drag.current?.moved) return; const n = nearest(e.clientX, e.clientY); if (n) onHospital(n); }}>
        <defs>
          <pattern id={`dots-${uid}`} width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="#d5dcec" /></pattern>
          <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <filter id={`shadow-${uid}`} x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#1e293b" floodOpacity="0.22" /></filter>
          <filter id={`nshadow-${uid}`} x="-60%" y="-60%" width="220%" height="240%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.6" floodColor="#1e293b" floodOpacity="0.3" /></filter>
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
        {tiles.map((t) => <image key={t.key} href={t.url} x={t.x} y={t.y} width={t.size} height={t.size} />)}
        <rect width={W} height={Hh} fill="#fff" fillOpacity={0.2} />

        {moves.map((mv, i) => {
          const a = P[mv.from], b = P[mv.to];
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          const close = d < 2 * R + 8;                                  // hospitals in the same spot: run centre to centre
          const r0 = close ? 0 : R + 2, r1 = close ? 0 : R + 7;
          const sx = a.x + (dx / d) * r0, sy = a.y + (dy / d) * r0, ex = b.x - (dx / d) * r1, ey = b.y - (dy / d) * r1;
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

        {drawOrder.map((h) => {
          const p = P[h.id], rk = worst(h.id), hot = rk === "critical" || rk === "stockout";
          const active = hover === h.id;
          return (
            <g key={h.id} pointerEvents="none">
              {hot && <circle cx={p.x} cy={p.y} r={R + 2} fill={RISK[rk].color} className="pulse-ring" />}
              <circle cx={p.x} cy={p.y} r={active ? R * 1.9 : R * 1.5} fill={RISK[rk].color} fillOpacity={0.12} style={{ transition: "r 160ms" }} />
              <circle cx={p.x} cy={p.y} r={active ? R * 1.2 : R} fill="#fff" stroke={RISK[rk].color} strokeWidth={2.4 * Math.sqrt(R / 10)} filter={`url(#nshadow-${uid})`} style={{ transition: "r 160ms" }} />
              <text x={p.x} y={p.y + R * 0.38} textAnchor="middle" fontSize={R * (active ? 1.2 : 1.05)} fontWeight={800} fill={C.ink}>{h.id}</text>
            </g>
          );
        })}

        {visible.map((h) => {
          const l = labels[h.id];
          return (
            <g key={`l-${h.id}`} pointerEvents="none" opacity={hover !== null && hover !== h.id ? 0.55 : 1}>
              <text x={l.x} y={l.y} textAnchor={l.anchor} fontSize="9.5" fontWeight={600} fill="#1e293b" paintOrder="stroke" stroke="#fff" strokeWidth={3.5}>{short(h.name)}</text>
              <text x={l.x} y={l.y + 10.5} textAnchor={l.anchor} fontSize="8.5" fill="#475569" paintOrder="stroke" stroke="#fff" strokeWidth={3.5}>{h.city}</text>
            </g>
          );
        })}

        <g transform={`translate(16,${Hh - 22})`} fontSize="10.5" fill="#475569" fontWeight={600} pointerEvents="none">
          <rect x={-6} y={-14} width={390} height={24} rx={12} fill="#fff" fillOpacity={0.9} stroke="#e2e8f0" />
          <line x1={6} y1={-2} x2={30} y2={-2} stroke={C.brand} strokeWidth={3} strokeLinecap="round" />
          <text x={38} y={2}>Shortage transfer</text>
          <line x1={140} y1={-2} x2={164} y2={-2} stroke={C.teal} strokeWidth={3} strokeLinecap="round" />
          <text x={172} y={2}>Expiry rescue</text>
          <line x1={262} y1={-2} x2={286} y2={-2} stroke={C.orange} strokeWidth={3} strokeLinecap="round" />
          <text x={294} y={2}>Emergency loan</text>
        </g>
        <g transform={`translate(${W - 10},14)`} pointerEvents="none" fontSize="9.5" fill="#475569">
          <rect x={-160} y={-11} width={160} height={22} rx={11} fill="#fff" fillOpacity={0.92} stroke="#e2e8f0" />
          <text textAnchor="end" x={-10} y={3.5} fontWeight={500}>© OpenStreetMap contributors</text>
        </g>
      </svg>

      <div className="absolute top-3 left-3 flex flex-col overflow-hidden rounded-xl border border-line bg-white/95 shadow-md" onPointerDown={(e) => e.stopPropagation()}>
        <button aria-label="Zoom in" title="Zoom in (or scroll)" disabled={atMax} onClick={() => zoomBy(1)}
          className="grid size-8 place-items-center text-slate-600 transition-colors hover:bg-slate-100 active:bg-slate-200 disabled:opacity-35"><Plus size={16} /></button>
        <button aria-label="Zoom out" title="Zoom out" disabled={atMin} onClick={() => zoomBy(-1)}
          className="grid size-8 place-items-center border-t border-line text-slate-600 transition-colors hover:bg-slate-100 active:bg-slate-200 disabled:opacity-35"><Minus size={16} /></button>
        <button aria-label="Fit all hospitals" title="Fit all hospitals" onClick={() => animateTo(fitRef.current)}
          className="grid size-8 place-items-center border-t border-line text-slate-600 transition-colors hover:bg-slate-100 active:bg-slate-200"><LocateFixed size={15} /></button>
      </div>
    </div>
  );
}
