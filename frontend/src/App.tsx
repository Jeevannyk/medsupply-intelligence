import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, Bot, Boxes, Building2, CheckCircle2, CircleAlert, FlaskConical, Hourglass, LayoutDashboard, LineChart, Map as MapIcon,
  Menu, Pill, RefreshCw, Scale, Share2, Siren, ArrowLeftRight, X, type LucideIcon,
} from "lucide-react";
import { get, post, useApi, weightParams, type Meta, type Overview, type Scenario, type Weights } from "./api";
import CopilotDock from "./components/CopilotDock";
import { Button, Loading, Segmented, Select } from "./components/ui";
import { AppProvider, type Act, type AppState, type Names } from "./context";
import { go, Link, usePath } from "./router";
import Assistant from "./pages/Assistant";
import Dashboard from "./pages/Dashboard";
import Demand from "./pages/Demand";
import Exchange from "./pages/Exchange";
import Expiry from "./pages/Expiry";
import Hospitals, { HospitalDetailPage } from "./pages/Hospitals";
import Impact from "./pages/Impact";
import Inventory from "./pages/Inventory";
import MapPage from "./pages/MapView";
import Medicines from "./pages/Medicines";
import Priority from "./pages/Priority";
import Redistribution from "./pages/Redistribution";
import ScenarioPage from "./pages/Scenario";
import Shortage from "./pages/Shortage";

interface Route { path: string; label: string; title: string; sub: string; icon: LucideIcon; page: () => ReactNode; badge?: "shortage" | "expiry" | "moves" }
interface Group { name: string; items: Route[] }

const GROUPS: Group[] = [
  { name: "Overview", items: [
    { path: "/", label: "Dashboard", title: "Network dashboard", sub: "Know before the shortage: live view of stock, demand, risk and transfers", icon: LayoutDashboard, page: () => <Dashboard /> },
  ] },
  { name: "Predict", items: [
    { path: "/inventory", label: "Inventory", title: "Network inventory", sub: "What each hospital holds, how long it lasts, and how it compares with resupply time", icon: Boxes, page: () => <Inventory /> },
    { path: "/demand", label: "Demand forecast", title: "Demand forecast", sub: "14-day demand per hospital and medicine, with outbreak detection and backtest accuracy", icon: LineChart, page: () => <Demand /> },
    { path: "/shortage", label: "Shortage risk", title: "Shortage risk", sub: "Which hospital runs out of which medicine, and whether resupply can arrive in time", icon: Siren, page: () => <Shortage />, badge: "shortage" },
    { path: "/expiry", label: "Expiry & wastage", title: "Expiry & wastage", sub: "Stock that will expire before it can be used, and how to rescue it", icon: Hourglass, page: () => <Expiry />, badge: "expiry" },
  ] },
  { name: "Act", items: [
    { path: "/redistribution", label: "Redistribution", title: "Redistribution engine", sub: "Optimiser-proposed transfers with verification and a balanced ledger", icon: Share2, page: () => <Redistribution />, badge: "moves" },
    { path: "/priority", label: "Prioritisation", title: "Prioritisation", sub: "Who gets scarce stock first, and why. Adjust the weights live", icon: Scale, page: () => <Priority /> },
    { path: "/exchange", label: "Hospital exchange", title: "Hospital exchange", sub: "Offers, requests, transfers and messages between hospitals", icon: ArrowLeftRight, page: () => <Exchange /> },
    { path: "/map", label: "Network map", title: "Network map", sub: "Transfers and risk on real hospital locations", icon: MapIcon, page: () => <MapPage /> },
  ] },
  { name: "Analyse", items: [
    { path: "/impact", label: "Impact", title: "Impact", sub: "What happens with and without the system", icon: Activity, page: () => <Impact /> },
    { path: "/scenario", label: "Scenario test", title: "Scenario test", sub: "20,000 units against a demand ramp of 2,000 → 5,500 per week", icon: FlaskConical, page: () => <ScenarioPage /> },
    { path: "/hospitals", label: "Hospital nodes", title: "Hospital nodes", sub: "All 8 hospitals in the network", icon: Building2, page: () => <Hospitals /> },
    { path: "/medicines", label: "Medicines", title: "Medicine catalogue", sub: "Criticality, shelf life, alternatives and network stock", icon: Pill, page: () => <Medicines /> },
  ] },
  { name: "Assist", items: [
    { path: "/assistant", label: "Sentinel AI", title: "Sentinel", sub: "Plain-language answers grounded in the computed data", icon: Bot, page: () => <Assistant /> },
  ] },
];
const ROUTES = GROUPS.flatMap((g) => g.items);

function resolve(path: string): { route: Route | null; hospital?: string } {
  const h = path.match(/^\/hospitals\/([A-Za-z0-9]+)$/);
  if (h) return { route: ROUTES.find((r) => r.path === "/hospitals")!, hospital: h[1] };
  return { route: ROUTES.find((r) => r.path === path) ?? null };
}

export default function App() {
  const path = usePath();
  const [scenario, setScenario] = useState<Scenario>("outbreak");
  const [actor, setActor] = useState("NET");
  const [med, setMed] = useState("OSEL");
  const [hosp, setHosp] = useState("ALL");
  const [weights, setWeights] = useState<Weights | null>(null);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [menu, setMenu] = useState(false);
  const [copilot, setCopilot] = useState(false);

  const meta = useApi(() => get<Meta>("/meta"), []);
  const w = weights ?? meta.data?.default_weights ?? {};
  const wKey = JSON.stringify(w);
  const ov = useApi(() => get<Overview>("/overview", { scenario, ...weightParams(w) }), [scenario, wKey, version]);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => setMenu(false), [path]);

  if (meta.error) return <p className="p-8 text-red-700">Backend not reachable: {meta.error}. Start it with uvicorn (see README).</p>;
  if (!meta.data || !ov.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-8">
        {ov.error ? <p className="text-red-700">Error: {ov.error}</p> : <><Loading h="h-14" /><Loading h="h-32" /><Loading h="h-72" /></>}
      </div>
    );
  }
  const m = meta.data;
  const H = Object.fromEntries(m.hospitals.map((h) => [h.id, h]));
  const M = Object.fromEntries(m.medicines.map((x) => [x.id, x]));
  const names: Names = {
    hn: (id) => (id === "AI" ? "Network AI" : id === "NET" ? "Network admin" : id === "ALL" ? "All hospitals" : H[id]?.name ?? id),
    mn: (id) => M[id]?.name ?? id,
    unit: (id) => M[id]?.unit ?? "units",
  };
  const act: Act = async (fn, ok) => {
    try {
      const r = await fn();
      setToast({ msg: typeof ok === "function" ? ok(r) : ok });
      setVersion((v) => v + 1);
    } catch (e) {
      setToast({ msg: (e as Error).message, error: true });
    }
  };
  const state: AppState = {
    meta: m, ov: ov.data, ovLoading: ov.loading, scenario, actor, setActor, med, setMed, hosp, setHosp,
    weights: w, setWeights, version, act, names,
  };

  const { route, hospital } = resolve(path);
  const badges = { shortage: ov.data.warnings.length, expiry: ov.data.expiry.length, moves: ov.data.plan.moves.length };
  const title = hospital ? names.hn(hospital) : route?.title ?? "Page not found";
  const sub = hospital ? "Hospital node: stock, risk, batches and exchange activity" : route?.sub ?? "";

  const sidebar = (
    <nav className="flex h-full flex-col">
      <Link to="/" className="flex items-center gap-3 px-5 py-5">
        <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-indigo-400 text-white shadow-lg shadow-brand/30"><Activity size={20} /></span>
        <span className="leading-tight"><b className="block text-[15px] tracking-tight">MedSupply</b><span className="text-[11px] font-medium text-muted">Supply intelligence</span></span>
      </Link>
      <div className="scroll-thin flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {GROUPS.map((g) => (
          <div key={g.name}>
            <h3 className="mb-1.5 px-3 text-[10px] font-bold tracking-widest text-slate-400 uppercase">{g.name}</h3>
            <ul className="space-y-0.5">
              {g.items.map((r) => {
                const on = route?.path === r.path;
                const n = r.badge ? badges[r.badge] : 0;
                return (
                  <li key={r.path}>
                    <Link to={r.path} className={`pressable group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold ${
                      on ? "bg-brand-soft text-brand-ink shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}>
                      {on && <i className="absolute top-2 bottom-2 -left-3 w-1 rounded-r-full bg-brand" />}
                      <r.icon size={18} className={on ? "text-brand" : "text-slate-400 transition-colors group-hover:text-slate-600"} />
                      <span className="flex-1">{r.label}</span>
                      {n > 0 && (
                        <span className={`num grid min-w-5 place-items-center rounded-full px-1.5 text-[10px] font-bold ${r.badge === "shortage" ? "bg-red-600 text-white" : r.badge === "expiry" ? "bg-amber-100 text-amber-800" : "bg-brand text-white"}`}>{n}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="m-3 rounded-2xl border border-line bg-gradient-to-br from-slate-50 to-indigo-50/60 p-3.5">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <i className="live-dot size-2 rounded-full bg-emerald-500" />Network telemetry live
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted">Today {m.today} · {m.hospitals.length} hospitals · {m.medicines.length} medicines</p>
        <p className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-slate-600">
          {ov.data.kpis.plan_verified ? <><CheckCircle2 size={13} className="text-emerald-600" />Plan verified</> : <><CircleAlert size={13} className="text-red-600" />Plan not verified</>}
        </p>
      </div>
    </nav>
  );

  return (
    <AppProvider value={state}>
      <div className="min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-white lg:block">{sidebar}</aside>
        {menu && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMenu(false)} />
            <aside className="slide-in relative h-full w-72 bg-white shadow-2xl">
              <button className="absolute top-4 right-3 rounded-lg p-1.5 text-muted hover:bg-slate-100" onClick={() => setMenu(false)} aria-label="Close menu"><X size={18} /></button>
              {sidebar}
            </aside>
          </div>
        )}

        <div className="lg:pl-64">
          <header className="glass sticky top-0 z-20">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
              <button className="rounded-lg p-2 hover:bg-slate-100 lg:hidden" onClick={() => setMenu(true)} aria-label="Open menu"><Menu size={20} /></button>
              <div className="mr-auto min-w-0">
                <h1 className="truncate text-lg font-bold tracking-tight">{title}</h1>
                <p className="truncate text-xs text-muted">{sub}</p>
              </div>
              <Segmented value={scenario} onChange={setScenario} size="sm"
                options={[{ value: "outbreak", label: "After outbreak" }, { value: "normal", label: "Before outbreak" }]} />
              <Select label="Acting as" value={actor} onChange={setActor} className="w-48">
                <option value="NET">Network admin</option>
                {m.hospitals.map((h) => <option key={h.id} value={h.id}>{h.id} · {h.name}</option>)}
              </Select>
              <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => act(() => post("/reset"), "Demo data regenerated")}>Reset demo</Button>
            </div>
          </header>

          <main key={path} className="page-in mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
            {hospital ? <HospitalDetailPage id={hospital} /> : route ? route.page() : (
              <div className="py-24 text-center">
                <p className="text-lg font-semibold">Page not found</p>
                <Button className="mt-4" onClick={() => go("/")}>Back to dashboard</Button>
              </div>
            )}
          </main>
        </div>

        <CopilotDock open={copilot} onOpen={() => setCopilot(true)} onClose={() => setCopilot(false)} path={route?.path ?? path} />

        {toast && (
          <div role="status" onClick={() => setToast(null)}
            className={`rise fixed right-4 bottom-4 z-50 flex max-w-md cursor-pointer items-start gap-2.5 rounded-xl px-4 py-3 text-sm text-white shadow-2xl ${toast.error ? "bg-red-700" : "bg-slate-900"}`}>
            {toast.error ? <CircleAlert size={18} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-400" />}
            <span>{toast.msg}</span><X size={14} className="mt-1 shrink-0 opacity-60" />
          </div>
        )}
      </div>
    </AppProvider>
  );
}
