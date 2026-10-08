import { useEffect, useState } from "react";
import { ArrowRight, Check, HandCoins, History, MapPinned, PackageX, Truck, TriangleAlert, Warehouse, X } from "lucide-react";
import { get, post, useApi, type Board, type LogisticsBoard, type ShipmentRow, type Transfer } from "../api";
import { DeliveryMap, type RoadPaths } from "../components/DeliveryMap";
import { carrierLine, ShipmentTracker } from "../components/ShipmentTracker";
import { Button, Card, Empty, Input, LoadError, Loading, Pill, Stat, fmt } from "../components/ui";
import { useApp, type Act, type Names } from "../context";
import { go } from "../router";
import { DeliveryArranger, ReceiveForm } from "./Exchange";

type Stage = "arrange" | "vehicle" | "ready" | "road" | "door" | "done";

const STAGES: { key: Stage; title: string; hint: string }[] = [
  { key: "arrange", title: "1 · Arrange delivery", hint: "Agreed. The donor chooses how it travels." },
  { key: "vehicle", title: "2 · Waiting for a vehicle", hint: "District pool request open." },
  { key: "ready", title: "3 · Ready to dispatch", hint: "Vehicle set. Donor hands over." },
  { key: "road", title: "4 · On the road", hint: "Tracked live, with ETA." },
  { key: "door", title: "5 · At the door", hint: "Receiver confirms with the code." },
  { key: "done", title: "6 · Delivered", hint: "Stock updated at both ends." },
];

const stageOf = (t: Transfer): Stage | null => {
  const s = t.shipment;
  if (t.status === "approved") return !s ? "arrange" : s.status === "requested" ? "vehicle" : "ready";
  if (t.status === "in_transit") return s?.at_door || s?.status === "arrived" ? "door" : "road";
  if (t.status === "delivered") return "done";
  return null;
};

/** Is it this role's move? Shown as a "your turn" badge on the card. */
function yourTurn(t: Transfer, stage: Stage, actor: string): boolean {
  if (actor === "DIST") return stage === "vehicle";
  if (actor === t.from_id) return stage === "arrange" || stage === "ready";
  return actor === t.to_id && (stage === "road" || stage === "door");
}

const hms = (iso: string | null) => (iso ? iso.slice(5, 16).replace("T", " ") : "");      // 10-08 23:07

export default function LogisticsPage() {
  const { actor, setActor, version, names, act, meta, ov } = useApp();
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 3000); return () => clearInterval(t); }, []);   // courier progress arrives by itself
  const viewer = actor !== "NET" && actor !== "DIST" ? actor : undefined;
  const ex = useApi(() => get<Board>("/exchange", { hospital: viewer }), [viewer, version, tick]);
  const lg = useApi(() => get<LogisticsBoard>("/logistics", { viewer }), [viewer, version, tick]);
  const roads = useApi(() => get<{ paths: RoadPaths }>("/road-paths"), []);      // real driving routes, fetched once

  const err = (ex.error && !ex.data ? ex.error : null) ?? (lg.error && !lg.data ? lg.error : null);
  if (err) return <LoadError error={err} retry={() => { ex.reload(); lg.reload(); }} />;
  if (!ex.data || !lg.data) return <Loading h="h-80" />;

  const { discrepancies, shipments } = lg.data;
  const items = ex.data.transfers.map((t) => ({ t, stage: stageOf(t) })).filter((x): x is { t: Transfer; stage: Stage } => x.stage !== null);
  const turn = (t: Transfer, stage: Stage) => yourTurn(t, stage, actor);
  const live = items.filter((x) => x.stage === "road" || x.stage === "door");
  const late = live.filter((x) => x.t.shipment?.delayed);
  const open = items.find((x) => x.t.id === sel) ?? items.find((x) => turn(x.t, x.stage)) ?? null;      // the card that shows its actions

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="On the road" value={live.length} icon={<Truck size={16} />} tone="teal" sub="dispatched, not yet confirmed" />
        <Stat label="Running late" value={late.length} icon={<TriangleAlert size={16} />} tone={late.length ? "red" : "green"} sub="ETA passed or carrier reported a delay" delay={50} />
        <Stat label="Awaiting a vehicle" value={items.filter((x) => x.stage === "vehicle").length} icon={<Warehouse size={16} />} tone="amber" sub="district pool requests" delay={100} />
        <Stat label="Receipt discrepancies" value={discrepancies.length} icon={<PackageX size={16} />} tone={discrepancies.length ? "amber" : "green"} sub="short or damaged on arrival" delay={150} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Live delivery map" icon={<MapPinned size={18} />}
          subtitle="Every hospital on OpenStreetMap. Each arranged delivery follows its real road with a truck. A dispatched truck takes 30 seconds to arrive; only then can the receiving hospital confirm with the code. Click a route to open it. Hold Ctrl and scroll to zoom.">
          <DeliveryMap meta={meta} ov={ov} transfers={ex.data.transfers} paths={roads.data?.paths ?? {}} selectedId={open?.t.id ?? null} zoomToSelected={sel !== null}
            onSelect={setSel} onSettled={() => { ex.reload(); lg.reload(); }} />
        </Card>

        <Card title="Delivery pipeline" icon={<Truck size={18} />} subtitle={`${items.length} ${items.length === 1 ? "delivery" : "deliveries"}, from agreed to delivered. Open a card to act on it.`}>
          {items.length === 0 ? (
            <Empty icon={<Truck size={26} />}>
              <p>No deliveries yet. A delivery starts once a transfer is approved.</p>
              <p className="text-xs">Redistribution → send a move → the donor approves in Hospital exchange → it appears here.</p>
              <div className="mt-1 flex gap-2"><Button size="sm" onClick={() => go("/redistribution")}>Open Redistribution</Button><Button size="sm" variant="secondary" onClick={() => go("/exchange")}>Open Hospital exchange</Button></div>
            </Empty>
          ) : (
            <div className="max-h-[600px] space-y-4 overflow-y-auto pr-1 scroll-thin">
              {STAGES.map((st) => {
                const here = items.filter((x) => x.stage === st.key);
                return (
                  <section key={st.key} aria-label={st.title}>
                    <h3 className="flex items-center gap-2 text-sm font-bold">{st.title}<span className="num rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">{here.length}</span></h3>
                    <p className="mb-2 text-xs leading-4 text-muted">{st.hint}</p>
                    <ul className="space-y-2">
                      {here.slice(0, st.key === "done" ? 6 : 50).map(({ t }) => (
                        <StageCard key={t.id} t={t} stage={st.key} selected={open?.t.id === t.id} turn={turn(t, st.key)} names={names} onPick={() => setSel(t.id)}>
                          <Actions t={t} stage={st.key} actor={actor} names={names} act={act} setActor={setActor} />
                        </StageCard>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card title="Delivery log" icon={<History size={18} />} subtitle="Every delivery from the database, newest first.">
        {shipments.length === 0 ? <Empty>No deliveries logged yet.</Empty> : (
          <ul className="divide-y divide-line">
            {(all ? shipments : shipments.slice(0, 8)).map((s) => <LogRow key={s.id} s={s} names={names} missing={discrepancies.find((d) => d.transfer_id === s.transfer_id)} />)}
          </ul>
        )}
        {shipments.length > 8 && <Button className="mt-2" size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${shipments.length}`}</Button>}
      </Card>
    </div>
  );
}

const LOG_STATE: Record<string, { label: string; tone: "slate" | "amber" | "brand" | "teal" | "green" | "red" }> = {
  planned: { label: "Arranged", tone: "slate" }, requested: { label: "Needs vehicle", tone: "amber" }, assigned: { label: "Vehicle assigned", tone: "brand" },
  in_transit: { label: "On the road", tone: "teal" }, arrived: { label: "At the door", tone: "green" }, delivered: { label: "Delivered", tone: "green" }, cancelled: { label: "Cancelled", tone: "red" },
};

/** One delivery in two lines: what moved and its state, then the details. */
function LogRow({ s, names, missing }: { s: ShipmentRow; names: Names; missing?: LogisticsBoard["discrepancies"][number] }) {
  const state = s.status === "in_transit" && s.at_door ? LOG_STATE.arrived : s.status === "in_transit" && s.delayed ? { label: "Delayed", tone: "red" as const } : LOG_STATE[s.status];
  const bits = [
    s.mode_label, carrierLine(s),
    s.dispatched_at && `dispatched ${hms(s.dispatched_at)}`,
    s.delivered_at && `delivered ${hms(s.delivered_at)}`,
    s.status === "delivered" && s.received_qty !== null && `accepted ${fmt(s.received_qty)} of ${fmt(s.qty)}`,
    missing && `${fmt(missing.missing)} ${missing.condition}, ${missing.resolution.replace(/_/g, " ")}`,
  ].filter(Boolean);
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <b>#{s.transfer_id}</b>
        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-bold">{s.from_id}<ArrowRight size={10} />{s.to_id}</span>
        <span className="num font-semibold">{fmt(s.qty)} {names.unit(s.medicine_id)}</span>
        <span className="text-muted">{names.mn(s.medicine_id)}</span>
        <span className="ml-auto"><Pill tone={state.tone}>{state.label}</Pill></span>
      </div>
      <p className="mt-0.5 text-xs leading-5 text-muted">{bits.join(" · ")}</p>
    </li>
  );
}

function StageCard({ t, stage, selected, turn, names, onPick, children }: {
  t: Transfer; stage: Stage; selected: boolean; turn: boolean; names: Names; onPick: () => void; children: React.ReactNode;
}) {
  const s = t.shipment;
  const late = !!s?.delayed && stage === "road";
  return (
    <li className={`rounded-xl border bg-white shadow-sm ${selected ? "border-brand ring-2 ring-brand/30" : late ? "border-red-300" : "border-line hover:border-brand/40"}`}>
      <button onClick={onPick} aria-pressed={selected} className="pressable w-full rounded-xl p-2.5 text-left text-xs">
        <div className="flex items-center gap-1.5">
          <b>#{t.id}</b>
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-bold">{t.from_id}<ArrowRight size={10} />{t.to_id}</span>
          {turn && <span className="ml-auto rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-white">your turn</span>}
        </div>
        <p className="num mt-1 font-semibold">{fmt(t.qty)} {names.unit(t.medicine_id)}</p>
        <p className="truncate text-muted">{names.mn(t.medicine_id)}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s && <Pill tone="brand">{s.mode_label}</Pill>}
          {late && <Pill tone="red">Delayed</Pill>}
          {s?.cold_chain ? <Pill tone="teal">Cold chain</Pill> : null}
        </div>
        {(stage === "road" || stage === "door") && s && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full ${late ? "bg-red-500" : "bg-teal-500"}`} style={{ width: `${Math.max(5, s.progress * 100)}%` }} /></div>
        )}
      </button>
      {selected && <div className="space-y-3 border-t border-line p-2.5">{children}</div>}
    </li>
  );
}

/** What the acting role can do with the open delivery. */
function Actions({ t, stage, actor, names, act, setActor }: { t: Transfer; stage: Stage; actor: string; names: Names; act: Act; setActor: (a: string) => void }) {
  const s = t.shipment;
  const donor = actor === t.from_id, receiver = actor === t.to_id, isHosp = donor || receiver;
  const dispatch = () => act(() => post(`/transfers/${t.id}/action`, { action: "dispatch", actor }),
    (r: Transfer) => `Dispatched #${t.id}: the truck is on its way and arrives in about 30 s. Handover code ${r.shipment?.handover_code}: give it to the driver; ${names.hn(t.to_id)} needs it to confirm.`);
  const cancel = () => act(() => post(`/transfers/${t.id}/action`, { action: "cancel", actor }), `Cancelled #${t.id}.`);
  return (
    <>
      {s && <ShipmentTracker s={s} showCode={donor && stage === "road"} />}
      {actor === "DIST" && stage === "vehicle" && s && <AssignVehicle id={s.id} act={act} />}
      {actor === "DIST" && stage !== "vehicle" && <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-muted">The district office only acts on pool requests.</p>}
      {donor && (stage === "arrange" || stage === "ready" || stage === "vehicle") && (
        <>
          <DeliveryArranger key={`${t.id}-${s?.status ?? "none"}`} t={t} actor={actor} act={act} />
          <div className="flex flex-wrap gap-2">
            <Button variant="success" icon={<Truck size={15} />} disabled={stage === "vehicle"} onClick={dispatch}
              title={stage === "vehicle" ? "Waiting for the district office to assign a vehicle" : "Hand the goods over now"}>Dispatch now</Button>
            <Button variant="danger" icon={<X size={15} />} onClick={cancel}>Cancel transfer</Button>
          </div>
          {stage === "vehicle" && <p className="text-xs text-muted">Dispatch unlocks once the district office assigns a vehicle.</p>}
        </>
      )}
      {donor && (stage === "road" || stage === "door") && <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-muted">On its way. Give the driver the handover code above; {names.hn(t.to_id)} needs it to confirm receipt.</p>}
      {receiver && (stage === "road" || stage === "door") && <ReceiveForm t={t} actor={actor} names={names} act={act} />}
      {receiver && (stage === "arrange" || stage === "ready" || stage === "vehicle") && (
        <div className="space-y-2">
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-muted">{names.hn(t.from_id)} is arranging the delivery. You can confirm receipt once it is dispatched and has arrived.</p>
          <Button variant="danger" size="sm" icon={<X size={14} />} onClick={cancel}>Cancel transfer</Button>
        </div>
      )}
      {isHosp && stage === "done" && (
        <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900"><Check size={14} />Delivered and recorded.{s?.condition && s.condition !== "ok" ? " A discrepancy was logged." : ""}</p>
      )}
      {!isHosp && actor !== "DIST" && (
        <div className="space-y-2 rounded-xl bg-slate-50 px-3 py-3 text-xs text-muted">
          <p>You are watching as <b>{names.hn(actor)}</b>. Only the hospitals involved can act.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="subtle" onClick={() => setActor(t.from_id)}>Act as {t.from_id} (donor)</Button>
            <Button size="sm" variant="subtle" onClick={() => setActor(t.to_id)}>Act as {t.to_id} (receiver)</Button>
            {stage === "vehicle" && <Button size="sm" variant="subtle" onClick={() => setActor("DIST")}>Act as District office</Button>}
          </div>
        </div>
      )}
      {s && stage === "road" && (
        <div className="rounded-xl border border-dashed border-line px-3 py-2.5 text-xs">
          <p className="font-semibold text-ink">Demo controls</p>
          <p className="text-muted">Make this trip run late and watch the plan react (+24 h changes it most).</p>
          <div className="mt-1.5 flex gap-2">
            {[6, 24].map((h) => (
              <Button key={h} size="sm" variant="secondary" icon={<HandCoins size={13} />}
                onClick={() => act(() => post(`/logistics/shipments/${s.id}/delay`, { hours: h, reason: "Road closure (demo)" }), `Trip delayed by ${h} h. The plan is recalculated.`)}>Delay +{h} h</Button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function AssignVehicle({ id, act }: { id: number; act: Act }) {
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/50 p-3 text-xs">
      <p className="font-semibold text-ink">Assign a pool vehicle</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Input className="h-9" placeholder="Vehicle, e.g. DK-01-G-77" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
        <Input className="h-9" placeholder="Driver name" value={driver} onChange={(e) => setDriver(e.target.value)} />
      </div>
      <Button size="sm" className="mt-2" icon={<Check size={14} />} disabled={!vehicle.trim() || !driver.trim()}
        onClick={() => act(() => post(`/logistics/shipments/${id}/assign`, { actor: "DIST", vehicle, driver }), `Vehicle ${vehicle} assigned. The donor can dispatch.`)}>Assign vehicle</Button>
    </div>
  );
}
