import { useCallback, useEffect, useRef, useState } from "react";

export type Risk = "stockout" | "critical" | "high" | "watch" | "ok";
export type Scenario = "outbreak" | "normal";
export type Weights = Record<string, number>;

export interface Hospital {
  id: string; name: string; city: string; lat: number; lon: number;
  beds: number; patient_load: number; emergency_index: number;
}
export interface Medicine {
  id: string; name: string; unit: string; criticality: number;
  shelf_life_days: number; alternatives: string[]; unit_cost: number;
}
export interface Meta {
  today: string; scenarios: Record<Scenario, string>; hospitals: Hospital[]; medicines: Medicine[];
  default_weights: Weights; meta: Record<string, string>;
  transport: { from: string; to: string; hours: number; km: number }[];
}
export interface Priority {
  score: number; factors: Record<string, number>; contributions: Record<string, number>;
  alternative: string | null; alternative_spare_days: number; explanation: string;
}
export interface Cell {
  hospital: string; medicine: string; stock: number; on_hand: number; physical: number; incoming: number; outgoing: number;
  daily_forecast: number; forecast_7d: number; forecast_14d: number; days_of_cover: number | null;
  days_to_stockout: number | null; days_to_stockout_p90: number | null; lead_days: number; risk: Risk;
  need: number; surplus: number; reserve: number; projected_waste: number; waste_value: number;
  order_qty: number; spike: boolean; surge: number; message: string; priority: Priority;
}
export interface Allocation { batch_id: string; qty: number; expires_in_days: number }
export interface Move {
  id: string; key: string; from: string; to: string; qty: number; hours: number; km: number; kind: "need" | "rescue" | "emergency";
  arrival_day: number; allocations: Allocation[]; medicine: string; unit: string; covers_days: number | null;
  rescued_from_expiry: number; recipient_days_to_stockout: number | null; recipient_lead_days: number;
  recipient_priority: number; text: string; reason: string;
}
export interface ExpiryRow {
  batch_id: string; hospital: string; medicine: string; qty: number; expiry_date: string; days_left: number;
  demand_before_expiry: number; expected_use: number; used_by_earlier_batches: number; projected_waste: number;
  waste_pct: number; value: number; virtual: boolean; reason: string;
}
export interface Check { name: string; passed: boolean; detail: string }
export interface LedgerRow {
  hospital: string; medicine: string; role: string; before: number; out: number; in: number; after: number;
  dts_before: number | null; dts_after: number | null; window_days: number;
  unmet_window_before: number; unmet_window_after: number; waste_before: number; waste_after: number;
  balanced: boolean;
}
export interface Verification {
  passed: boolean; checks: Check[]; totals: { medicine: string; before: number; after: number; moved: number }[];
  ledger: LedgerRow[];
  summary: Record<string, number>;
}
export interface OutcomeSide {
  stockout_cells: number; stockout_days: number; unmet_units: number; unmet_critical: number; waste: number;
}
export interface Outcome {
  horizon_days: number; basis: string; without: OutcomeSide; with: OutcomeSide;
  daily: { day: number; date: string; without: number; with: number }[];
  cells: { hospital: string; medicine: string; unmet_without: number; unmet_with: number }[];
}
export interface ErrorMetrics { mae: number; mape: number; wape: number }
export interface Overview {
  scenario: Scenario; weights: Weights; today: string; cells: Cell[]; warnings: Cell[];
  spikes: { hospital: string; medicine: string; surge: number; z: number; growth_per_day: number; detected_date: string }[];
  expiry: ExpiryRow[];
  plan: { moves: Move[]; shortfalls: { hospital: string; medicine: string; need: number; received: number; shortfall: number; priority: number; lead_days: number; alternative: string | null; alternative_spare_days: number }[] };
  verification: Verification;
  orders: { hospital: string; medicine: string; qty: number; arrives_in_days: number; text: string }[];
  outcome: Outcome;
  metrics: {
    holdout_days: number; origin_day: number; spike_series_count: number;
    overall: Record<string, ErrorMetrics>; spike_series: Record<string, ErrorMetrics>;
    network_by_medicine: Record<string, Record<string, ErrorMetrics>>;
  };
  kpis: Record<string, number | boolean>;
}
export interface Series {
  medicine: string; hospital: string; spike: boolean; spike_series: number; detected_date: string | null;
  outbreak_start: string; next_7d: number; next_14d: number;
  history: { date: string; actual: number; anomaly: boolean }[];
  forecast: { date: string; p50: number; p10: number; p90: number; gbm: number }[];
  weekly: { week_ending: string; units: number }[];
}
export interface Message {
  id: number; ts: string; sender: string; recipient: string; kind: string; body: string;
  transfer_id: number | null; offer_id: number | null; request_id: number | null;
}
export interface Transfer {
  id: number; medicine_id: string; from_id: string; to_id: string; qty: number; allocations: Allocation[];
  status: "pending" | "approved" | "in_transit" | "delivered" | "declined" | "cancelled";
  awaiting: string | null; origin: string; reason: string; hours: number; created_at: string; updated_at: string;
  messages?: Message[];
}
export interface Offer {
  id: number; hospital_id: string; medicine_id: string; batch_id: string | null; qty: number; remaining: number;
  expiry_date: string; note: string; status: string; created_at: string; target: string | null;
}
export interface StockRequest {
  id: number; hospital_id: string; medicine_id: string; qty: number; remaining: number;
  needed_within_days: number; note: string; status: string; created_at: string; target: string | null;
}
export interface Board {
  transfers: Transfer[]; offers: Offer[]; requests: StockRequest[]; messages: Message[];
  counts: Record<string, number>; todo: Transfer[];
}
export interface Judge {
  medicine: string; stock_total: number; weekly_demand: number[]; aggregate_cover_days: number;
  forecast_14d: { p50: number; p10: number; p90: number }; hospitals: Cell[]; moves: Move[]; ledger: LedgerRow[];
  totals: { before: number; after: number; moved: number }; checks: Check[]; passed: boolean; statement: string;
}
export interface HospitalDetail {
  hospital: Hospital; cells: Cell[]; expiry: ExpiryRow[]; moves: Move[];
  orders: Overview["orders"]; lead_times: Record<string, number>;
  batches: { medicine: string; batch_id: string; qty: number; days_left: number; expiry_date: string; virtual: boolean; arrive_day: number }[];
  exchange: Board;
}
export interface AssistantReply {
  answer: string; mode: string; note?: string; tools: { name: string; args: Record<string, unknown>; result: unknown }[];
}

type Params = Record<string, string | number | undefined | null>;

function qs(params?: Params) {
  if (!params) return "";
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && p.set(k, String(v)));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function weightParams(w: Weights): Params {
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [`w_${k}`, v]));
}

export async function get<T>(path: string, params?: Params): Promise<T> {
  const r = await fetch(`/api${path}${qs(params)}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText);
  return r.json();
}

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText);
  return r.json();
}

export function useApi<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    fn().then(
      (d) => { if (id === seq.current) { setData(d); setError(null); setLoading(false); } },
      (e: Error) => { if (id === seq.current) { setError(e.message); setLoading(false); } },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { data, error, loading, reload: load };
}
