import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Risk } from "../api";

export const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const inr = (n: number) => `₹${fmt(n)}`;

/** 23 s, 4 min, 2.5 h: the time left on a trip at the scale that matters. */
export function fmtLeft(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "–";
  if (seconds <= 0) return "arrived";
  if (seconds < 120) return `${Math.ceil(seconds)} s left`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

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
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${RISK[risk].badge} ${className}`}>
      {(risk === "critical" || risk === "stockout") && <i className="live-dot inline-block size-1.5 rounded-full bg-white" />}
      {RISK[risk].label}
    </span>
  );
}

export function Card({ id, title, subtitle, icon, actions, children, className = "", hover = false, flush = false }: {
  id?: string; title?: string; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode;
  children: ReactNode; className?: string; hover?: boolean; flush?: boolean;
}) {
  return (
    <section id={id} className={`card-surface rounded-2xl border border-line bg-white ${hover ? "card-hover" : ""} ${className}`}>
      {title && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            {icon && <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">{icon}</span>}
            <div>
              <h2 className="text-[15px] font-semibold leading-6 tracking-tight">{title}</h2>
              {subtitle && <p className="text-xs leading-5 text-muted">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "" : `px-5 pb-5 ${title ? "" : "pt-5"}`}>{children}</div>
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid" | "subtle" | "success";

export function Button({ children, onClick, variant = "primary", disabled, size = "md", title, type = "button", icon, loading, className = "" }: {
  children?: ReactNode; onClick?: () => void; variant?: Variant; disabled?: boolean; size?: "sm" | "md" | "lg";
  title?: string; type?: "button" | "submit"; icon?: ReactNode; loading?: boolean; className?: string;
}) {
  const v: Record<Variant, string> = {
    primary: "btn-primary text-white",
    success: "btn-success text-white",
    "danger-solid": "btn-danger-solid text-white",
    secondary: "border border-line bg-white text-ink shadow-sm hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink",
    ghost: "text-muted hover:bg-slate-100 hover:text-ink",
    danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300",
    subtle: "bg-brand-soft text-brand-ink hover:bg-indigo-100",
  };
  const s = { sm: "h-8 gap-1.5 px-3 text-xs", md: "h-10 gap-2 px-4 text-sm", lg: "h-11 gap-2 px-5 text-sm" }[size];
  return (
    <button type={type} title={title} disabled={disabled || loading} onClick={onClick}
      className={`inline-flex shrink-0 items-center justify-center rounded-xl font-semibold whitespace-nowrap transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${v[variant]} ${s} ${className}`}>
      {loading ? <i className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : icon}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-xl bg-slate-100 p-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`rounded-lg font-semibold whitespace-nowrap transition-all duration-150 ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-[13px]"} ${
            value === o.value ? "bg-white text-brand-ink shadow-sm ring-1 ring-black/5" : "text-muted hover:text-ink"}`}>
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
    <label className="inline-flex items-center gap-2 text-xs font-medium text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`h-9 rounded-xl border border-line bg-white px-3 text-sm font-medium text-ink shadow-sm transition-colors hover:border-brand/40 focus:border-brand ${className}`}>
        {children}
      </select>
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`h-10 rounded-xl border border-line bg-white px-3 text-sm shadow-sm transition-colors placeholder:text-slate-400 hover:border-brand/40 focus:border-brand ${props.className ?? ""}`} />;
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-slate-50/60 px-4 py-8 text-center text-sm text-muted">
      {icon && <span className="text-slate-400">{icon}</span>}
      {children}
    </div>
  );
}

export function Loading({ h = "h-40" }: { h?: string }) {
  return <div className={`skeleton rounded-xl ${h}`} />;
}

/** Shown instead of a skeleton that would never go away. */
export function LoadError({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-900">
      <p className="font-semibold">This page could not load its data.</p>
      <p className="mt-1 leading-6">{error}</p>
      {retry && <Button className="mt-3" size="sm" variant="secondary" onClick={retry}>Try again</Button>}
    </div>
  );
}

export function Pill({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "brand" | "green" | "red" | "amber" | "teal" }) {
  const t = {
    slate: "bg-slate-100 text-slate-700", brand: "bg-brand-soft text-brand-ink", green: "bg-emerald-50 text-emerald-700",
    red: "bg-red-50 text-red-700", amber: "bg-amber-50 text-amber-800", teal: "bg-teal-50 text-teal-700",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${t}`}>{children}</span>;
}

/** Counts up to the target value (numbers only). */
export function AnimatedNumber({ value, format = (n: number) => fmt(n) }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(value); from.current = value; return; }
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 700);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(a + (value - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(Math.round(shown))}</>;
}

const TONES = {
  brand: "bg-brand-soft text-brand", red: "bg-red-50 text-red-600", amber: "bg-amber-50 text-amber-600",
  green: "bg-emerald-50 text-emerald-600", slate: "bg-slate-100 text-slate-600", teal: "bg-teal-50 text-teal-600",
};

export function Stat({ label, value, sub, icon, tone = "brand", delay = 0 }: {
  label: string; value: ReactNode; sub?: ReactNode; icon: ReactNode; tone?: keyof typeof TONES; delay?: number;
}) {
  return (
    <div className="card-surface card-hover rise rounded-2xl border border-line bg-white p-4" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
        <span className={`grid size-8 place-items-center rounded-lg ${TONES[tone]}`}>{icon}</span>
      </div>
      <div className="num mt-2 text-2xl leading-8 font-bold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={`grid size-5 place-items-center rounded-full text-[10px] ${i <= current ? "bg-brand text-white" : "bg-slate-200 text-slate-500"}`}>{i + 1}</span>
          <span className={i <= current ? "text-ink" : "text-muted"}>{s}</span>
          {i < steps.length - 1 && <span className={`h-px w-4 ${i < current ? "bg-brand" : "bg-slate-200"}`} />}
        </li>
      ))}
    </ol>
  );
}

/** Whole seconds still to wait, counting down locally from the figure the server gave when the data was fetched. */
export function useCountdown(seconds: number | null | undefined, key: string): number {
  const [now, setNow] = useState(() => Date.now());
  const start = useRef(Date.now());
  useEffect(() => { start.current = Date.now(); setNow(Date.now()); }, [seconds, key]);
  useEffect(() => {
    if (seconds === null || seconds === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [seconds, key]);
  if (seconds === null || seconds === undefined) return 0;
  return Math.max(0, Math.ceil(seconds - (now - start.current) / 1000));
}
