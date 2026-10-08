import type { ReactNode } from "react";
import type { Risk } from "../api";

export const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const inr = (n: number) => `₹${fmt(n)}`;

export const RISK: Record<Risk, { label: string; badge: string; color: string; soft: string }> = {
  stockout: { label: "Out of stock", badge: "bg-risk-stockout text-white", color: "#7f1d1d", soft: "#fde8e8" },
  critical: { label: "Critical", badge: "bg-risk-critical text-white", color: "#dc2626", soft: "#fee2e2" },
  high: { label: "Order now", badge: "bg-risk-high text-white", color: "#ea580c", soft: "#ffedd5" },
  watch: { label: "Watch", badge: "bg-amber-100 text-amber-800 ring-1 ring-amber-300", color: "#ca8a04", soft: "#fef9c3" },
  ok: { label: "OK", badge: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200", color: "#16a34a", soft: "#ecfdf5" },
};
export const RISK_RANK: Record<Risk, number> = { stockout: 0, critical: 1, high: 2, watch: 3, ok: 4 };

export function RiskBadge({ risk, className = "" }: { risk: Risk; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${RISK[risk].badge} ${className}`}>
      {RISK[risk].label}
    </span>
  );
}

export function Card({ id, step, title, subtitle, actions, children, className = "" }: {
  id?: string; step?: number | string; title: string; subtitle?: ReactNode; actions?: ReactNode;
  children: ReactNode; className?: string;
}) {
  return (
    <section id={id} className={`rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-start gap-3">
          {step !== undefined && (
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-brand text-xs font-bold text-white">{step}</span>
          )}
          <div>
            <h2 className="text-[15px] font-semibold leading-6">{title}</h2>
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Button({ children, onClick, variant = "primary", disabled, size = "md", title, type = "button" }: {
  children: ReactNode; onClick?: () => void; variant?: "primary" | "ghost" | "danger" | "subtle";
  disabled?: boolean; size?: "sm" | "md"; title?: string; type?: "button" | "submit";
}) {
  const v = {
    primary: "bg-brand text-white hover:bg-brand-ink",
    ghost: "border border-line bg-white text-ink hover:bg-slate-50",
    danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
    subtle: "bg-brand-soft text-brand-ink hover:bg-teal-100",
  }[variant];
  const s = size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm";
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${v} ${s}`}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`rounded-md font-medium transition-colors ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} ${
            value === o.value ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, onChange, children, className = "", label }: {
  value: string; onChange: (v: string) => void; children: ReactNode; className?: string; label?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`h-8 rounded-lg border border-line bg-white px-2 text-sm text-ink focus:outline-2 focus:outline-brand ${className}`}>
        {children}
      </select>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{children}</div>;
}

export function Loading() {
  return <div className="h-40 animate-pulse rounded-lg bg-slate-100" />;
}
