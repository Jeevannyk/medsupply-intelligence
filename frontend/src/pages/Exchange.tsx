import { useState } from "react";
import { ArrowRight, Check, HandCoins, Inbox as InboxIcon, Megaphone, MessageSquare, PackagePlus, Send, Truck, Undo2, X } from "lucide-react";
import { get, post, useApi, type Board, type Offer, type StockRequest, type Transfer } from "../api";
import { Button, Card, Empty, Input, Loading, Pill, Segmented, Stat, Stepper, fmt } from "../components/ui";
import { useApp, type Act, type Names } from "../context";

const STEP: Record<string, number> = { pending: 0, approved: 1, in_transit: 2, delivered: 3 };
const TONE: Record<string, "amber" | "brand" | "teal" | "green" | "red" | "slate"> = {
  pending: "amber", approved: "brand", in_transit: "teal", delivered: "green", declined: "red", cancelled: "slate",
};
const LABEL: Record<string, string> = {
  pending: "Awaiting donor", approved: "Agreed · awaiting dispatch", in_transit: "In transit", delivered: "Delivered", declined: "Declined", cancelled: "Cancelled",
};
const ORIGIN: Record<string, string> = { ai_plan: "Network proposal", offer: "Offer accepted", request: "Request accepted" };

const FIELD = "mt-1 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm font-medium text-ink shadow-sm transition-colors hover:border-brand/40 focus:border-brand";

type Post = Offer | StockRequest;
const isOffer = (p: Post): p is Offer => "batch_id" in p;

export default function ExchangePage() {
  const { names, actor, setActor, version, act } = useApp();
  const b = useApi(() => get<Board>("/exchange", { hospital: actor === "NET" ? undefined : actor }), [actor, version]);
  const [tab, setTab] = useState<"inbox" | "transfers" | "new">("inbox");
  const isHosp = actor !== "NET";

  if (!b.data) return <Loading h="h-80" />;
  const { transfers, offers, requests } = b.data;
  const openReq = requests.filter((r) => r.status === "open");
  const openOff = offers.filter((o) => o.status === "open");

  /* ------------------------------------------------ network admin: read-only overview */
  if (!isHosp) {
    const live = transfers.filter((t) => ["pending", "approved", "in_transit"].includes(t.status));
    return (
      <div className="space-y-5">
        <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm leading-6 text-indigo-900">
          <b>Network admin view is read-only.</b> Hospitals post, accept, approve, dispatch and receive. The admin proposes transfers from Redistribution and watches them here.
          Use <b>Act as</b> to continue as a hospital.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Open requests" value={openReq.length} icon={<HandCoins size={16} />} tone="amber" sub="waiting for a donor" />
          <Stat label="Open offers" value={openOff.length} icon={<Megaphone size={16} />} tone="teal" sub="waiting for a taker" delay={50} />
          <Stat label="In progress" value={live.length} icon={<Truck size={16} />} tone="brand" sub="agreed or on the road" delay={100} />
          <Stat label="Delivered" value={transfers.filter((t) => t.status === "delivered").length} icon={<Check size={16} />} tone="green" sub="stock updated" delay={150} />
        </div>
        <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
          <Card title="Open requests & offers" subtitle="Posted by hospitals">
            {openReq.length + openOff.length === 0 ? <Empty>Nothing open.</Empty> : (
              <ul className="space-y-2">
                {openReq.map((r) => <PostRow key={`r${r.id}`} p={r} names={names} />)}
                {openOff.map((o) => <PostRow key={`o${o.id}`} p={o} names={names} />)}
              </ul>
            )}
          </Card>
          <Card title="Transfers" icon={<Truck size={18} />} subtitle="Every transfer in the network">
            {transfers.length === 0 ? <Empty>No transfers yet.</Empty> : (
              <ul className="space-y-3">
                {transfers.slice(0, 30).map((t) => <TransferCard key={t.id} t={t} actor={actor} names={names} version={version} act={act} onActAs={setActor} />)}
              </ul>
            )}
          </Card>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------ hospital view */
  const proposals = transfers.filter((t) => t.status === "pending" && t.awaiting === actor);
  const toMeReq = openReq.filter((r) => r.target === actor);
  const toMeOff = openOff.filter((o) => o.target === actor);
  const evReq = openReq.filter((r) => !r.target && r.hospital_id !== actor);
  const evOff = openOff.filter((o) => !o.target && o.hospital_id !== actor);
  const decisions = proposals.length + toMeReq.length + toMeOff.length;
  const inboxTotal = decisions + evReq.length + evOff.length;
  const myAction = transfers.filter((t) => (t.status === "approved" && t.from_id === actor) || (t.status === "in_transit" && t.to_id === actor)).length;
  const active = transfers.filter((t) => ["pending", "approved", "in_transit"].includes(t.status));
  const history = transfers.filter((t) => !["pending", "approved", "in_transit"].includes(t.status));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">You are <b className="text-ink">{names.hn(actor)}</b>. Someone asks or offers → the other side accepts → the donor dispatches → the receiver confirms. No admin in the loop.</p>
        <Segmented value={tab} onChange={setTab} options={[
          { value: "inbox", label: `Inbox${inboxTotal ? ` · ${inboxTotal}` : ""}` },
          { value: "transfers", label: `Transfers${myAction ? ` · ${myAction} to do` : ""}` },
          { value: "new", label: "New request / offer" },
        ]} />
      </div>

      {tab === "inbox" && (
        <div className="space-y-5">
          <Card title="Needs your decision" icon={<InboxIcon size={18} />} subtitle="Addressed to your hospital, so you can accept or decline.">
            {decisions === 0 ? <Empty icon={<InboxIcon size={26} />}>Nothing is waiting for you.</Empty> : (
              <ul className="space-y-3">
                {proposals.map((t) => (
                  <li key={`t${t.id}`} className="rounded-xl border border-amber-300 bg-amber-50/50 p-3.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Pill tone="amber">Network proposal</Pill>
                      <span>Send <b className="num">{fmt(t.qty)}</b> {names.unit(t.medicine_id)} of <b>{names.mn(t.medicine_id)}</b> to <b>{names.hn(t.to_id)}</b></span>
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" variant="success" icon={<Check size={14} />} onClick={() => act(() => post(`/transfers/${t.id}/action`, { action: "approve", actor }), `Approved #${t.id}. Dispatch it from Transfers.`)}>Approve</Button>
                        <Button size="sm" variant="danger" icon={<X size={14} />} onClick={() => act(() => post(`/transfers/${t.id}/action`, { action: "decline", actor }), `Declined #${t.id}.`)}>Decline</Button>
                      </div>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{t.reason}</p>
                  </li>
                ))}
                {toMeReq.map((r) => <PostCard key={`r${r.id}`} p={r} actor={actor} names={names} act={act} addressed />)}
                {toMeOff.map((o) => <PostCard key={`o${o.id}`} p={o} actor={actor} names={names} act={act} addressed />)}
              </ul>
            )}
          </Card>

          <Card title="Open to everyone" icon={<Megaphone size={18} />} subtitle="Broadcast by other hospitals. Any hospital that can help may accept.">
            {evReq.length + evOff.length === 0 ? <Empty>No open broadcasts.</Empty> : (
              <ul className="space-y-3">
                {evReq.map((r) => <PostCard key={`r${r.id}`} p={r} actor={actor} names={names} act={act} />)}
                {evOff.map((o) => <PostCard key={`o${o.id}`} p={o} actor={actor} names={names} act={act} />)}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === "transfers" && (
        <Card title="Transfers" icon={<Truck size={18} />} subtitle="Dispatch what you agreed to send; confirm what arrives. Stock changes only when the receiver confirms.">
          {transfers.length === 0 ? <Empty>No transfers yet. Accept something from the Inbox or post a request or offer.</Empty> : (
            <div className="space-y-5">
              {active.length > 0 && <ul className="space-y-3">{active.map((t) => <TransferCard key={t.id} t={t} actor={actor} names={names} version={version} act={act} />)}</ul>}
              {history.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">History</h3>
                  <ul className="space-y-3">{history.slice(0, 8).map((t) => <TransferCard key={t.id} t={t} actor={actor} names={names} version={version} act={act} />)}</ul>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === "new" && (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-2">
            <NewPost kind="request" actor={actor} names={names} act={act} />
            <NewPost kind="offer" actor={actor} names={names} act={act} />
          </div>
          <MyPosts offers={openOff.filter((o) => o.hospital_id === actor)} requests={openReq.filter((r) => r.hospital_id === actor)} names={names} actor={actor} act={act} />
        </div>
      )}
    </div>
  );
}

/* a request or an offer form: to one hospital, or to everyone */
function NewPost({ kind, actor, names, act }: { kind: "request" | "offer"; actor: string; names: Names; act: Act }) {
  const { meta, ov, scenario } = useApp();
  const [to, setTo] = useState("ALL");
  const [medicine, setMedicine] = useState("OSEL");
  const [qty, setQty] = useState(200);
  const [note, setNote] = useState("");
  const mine = ov.cells.find((c) => c.hospital === actor && c.medicine === medicine);
  const req = kind === "request";
  return (
    <Card title={req ? "Request stock" : "Offer stock"} icon={req ? <HandCoins size={18} /> : <PackagePlus size={18} />}
      subtitle={req ? "Ask one hospital, or broadcast so any hospital can accept." : "Offer to one hospital, or broadcast so any hospital in need can accept."}>
      <div className="space-y-3">
        <label className="block text-xs font-semibold text-muted">{req ? "Ask" : "Offer to"}
          <select value={to} onChange={(e) => setTo(e.target.value)} className={FIELD}>
            <option value="ALL">Everyone (broadcast)</option>
            {meta.hospitals.filter((h) => h.id !== actor).map((h) => <option key={h.id} value={h.id}>{h.id} · {h.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <label className="block text-xs font-semibold text-muted">Medicine
            <select value={medicine} onChange={(e) => setMedicine(e.target.value)} className={FIELD}>
              {meta.medicines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-semibold text-muted">Quantity
            <Input type="number" min={1} className="mt-1 w-full" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </label>
        </div>
        <label className="block text-xs font-semibold text-muted">Note (optional)
          <Input className="mt-1 w-full" placeholder={req ? "Why you need it" : "Anything the taker should know"} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {mine && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted">
            You hold <b className="num text-ink">{fmt(mine.physical)}</b> {names.unit(medicine)}{mine.stock !== mine.physical ? ` (${fmt(mine.stock)} projected after agreed transfers)` : ""} ({mine.days_of_cover ?? "–"} d of cover, lead time {mine.lead_days} d)
            {req ? mine.need > 0 ? <> and need about <b className="num text-ink">{fmt(mine.need)}</b> before resupply.</> : "." : <> with about <b className="num text-ink">{fmt(mine.surplus)}</b> spare.</>}
          </p>
        )}
        <Button className="w-full" icon={<Send size={15} />} disabled={qty <= 0}
          onClick={() => act(() => post(req ? "/requests" : "/offers", { hospital: actor, medicine, qty, note, target: to === "ALL" ? null : to, scenario }),
            () => `${req ? "Request" : "Offer"} ${to === "ALL" ? "broadcast to every hospital" : `sent to ${names.hn(to)}`}.`)}>
          {to === "ALL" ? "Broadcast" : "Send"} {req ? "request" : "offer"}
        </Button>
      </div>
    </Card>
  );
}

/* one open request or offer, read-only (admin overview) */
function PostRow({ p, names }: { p: Post; names: Names }) {
  const offer = isOffer(p);
  return (
    <li className="rounded-xl border border-line p-3 text-sm">
      <Pill tone={offer ? "teal" : "amber"}>{offer ? "offer" : "request"}</Pill>{" "}
      <b>{names.hn(p.hospital_id)}</b> {offer ? "offers" : "needs"} <b className="num">{fmt(p.remaining)}</b> {names.unit(p.medicine_id)} of {names.mn(p.medicine_id)}
      <span className="text-xs text-muted"> → {p.target ? names.hn(p.target) : "everyone"}</span>
    </li>
  );
}

/* a request or offer you can act on: accept (with a quantity) or, if addressed to you, decline */
function PostCard({ p, actor, names, act, addressed = false }: { p: Post; actor: string; names: Names; act: Act; addressed?: boolean }) {
  const { ov } = useApp();
  const offer = isOffer(p);
  const [qty, setQty] = useState(p.remaining);
  const mine = ov.cells.find((c) => c.hospital === actor && c.medicine === p.medicine_id);
  const path = offer ? "offers" : "requests";
  return (
    <li className={`rounded-xl border p-3.5 ${addressed ? "border-brand/40 bg-brand-soft/30" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill tone={offer ? "teal" : "amber"}>{offer ? "Offer" : "Request"}{addressed ? " to you" : ""}</Pill>
        <span><b>{names.hn(p.hospital_id)}</b> {offer ? "offers" : "needs"} <b className="num">{fmt(p.remaining)}</b> {names.unit(p.medicine_id)} of <b>{names.mn(p.medicine_id)}</b></span>
        <span className="text-xs text-muted">{offer ? `expires ${(p as Offer).expiry_date}` : `within ${(p as StockRequest).needed_within_days} d`}</span>
      </div>
      {p.note && <p className="mt-1 text-xs text-slate-600">“{p.note}”</p>}
      {mine && (
        <p className="mt-1 text-[11px] text-muted">
          {offer
            ? `Your stock: ${fmt(mine.physical)} on hand, ${mine.need > 0 ? `short by about ${fmt(mine.need)} before resupply` : "no shortage forecast"}.`
            : `Your stock: ${fmt(mine.physical)} on hand, about ${fmt(mine.surplus)} spare after your own forecast demand.`}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Input type="number" min={1} max={p.remaining} className="h-9 w-28" value={qty} onChange={(e) => setQty(Math.min(p.remaining, Math.max(0, Number(e.target.value))))} />
        <Button size="sm" variant="success" icon={<Check size={14} />} disabled={qty <= 0}
          onClick={() => act(() => post(offer ? `/offers/${p.id}/claim` : `/requests/${p.id}/respond`, offer ? { hospital: actor, qty } : { donor: actor, qty }),
            offer ? `Accepted ${fmt(qty)} from ${names.hn(p.hospital_id)}. They will dispatch it.` : `Accepted: you will send ${fmt(qty)} to ${names.hn(p.hospital_id)}. Dispatch it from Transfers.`)}>
          {offer ? "Accept offer" : "Send stock"}
        </Button>
        {addressed && (
          <Button size="sm" variant="danger" icon={<X size={14} />}
            onClick={() => act(() => post(`/${path}/${p.id}/decline`, { hospital: actor }), `Declined.`)}>Decline</Button>
        )}
      </div>
    </li>
  );
}

function MyPosts({ offers, requests, names, actor, act }: { offers: Offer[]; requests: StockRequest[]; names: Names; actor: string; act: Act }) {
  const items: Post[] = [...requests, ...offers];
  return (
    <Card title="Your open posts" icon={<Megaphone size={18} />} subtitle="Still waiting for someone to accept. Withdraw any time.">
      {items.length === 0 ? <Empty>You have no open requests or offers.</Empty> : (
        <ul className="space-y-2">
          {items.map((p) => {
            const offer = isOffer(p);
            return (
              <li key={`${offer ? "o" : "r"}${p.id}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-sm">
                <Pill tone={offer ? "teal" : "amber"}>{offer ? "offer" : "request"}</Pill>
                <span><b className="num">{fmt(p.remaining)}</b> {names.unit(p.medicine_id)} of {names.mn(p.medicine_id)} → <b>{p.target ? names.hn(p.target) : "everyone"}</b></span>
                <Button size="sm" variant="secondary" className="ml-auto" icon={<Undo2 size={14} />}
                  onClick={() => act(() => post(`/${offer ? "offers" : "requests"}/${p.id}/withdraw`, { hospital: actor }), "Withdrawn.")}>Withdraw</Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* a transfer and its next step. Only hospital nodes get buttons. */
function TransferCard({ t, actor, names, version, act, onActAs }: {
  t: Transfer; actor: string; names: Names; version: number; act: Act; onActAs?: (h: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isHosp = actor !== "NET";
  const can = {
    dispatch: isHosp && t.status === "approved" && actor === t.from_id,
    receive: isHosp && t.status === "in_transit" && actor === t.to_id,
    cancel: isHosp && (t.status === "pending" || t.status === "approved") && (actor === t.from_id || actor === t.to_id),
  };
  const next = t.status === "approved" ? t.from_id : t.status === "in_transit" ? t.to_id : t.status === "pending" ? t.awaiting : null;
  const go = (action: string, ok: string) => act(() => post(`/transfers/${t.id}/action`, { action, actor }), ok);
  const mine = (can.dispatch || can.receive);
  return (
    <li className={`rounded-xl border p-3.5 ${mine ? "border-brand/50 bg-brand-soft/30" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <b>#{t.id}</b>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold">{t.from_id}<ArrowRight size={12} />{t.to_id}</span>
        <span className="num font-semibold">{fmt(t.qty)} {names.unit(t.medicine_id)} · {names.mn(t.medicine_id)}</span>
        <Pill tone={TONE[t.status]}>{LABEL[t.status]}</Pill>
        <span className="text-[11px] text-muted">{ORIGIN[t.origin] ?? t.origin}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {can.dispatch && <Button size="sm" variant="success" icon={<Truck size={14} />} onClick={() => go("dispatch", `Dispatched #${t.id}. ${names.hn(t.to_id)} confirms receipt.`)}>Dispatch</Button>}
          {can.receive && <Button size="sm" variant="success" icon={<HandCoins size={14} />} onClick={() => go("receive", `Received #${t.id}. Your stock is updated.`)}>Confirm receipt</Button>}
          {can.cancel && <Button size="sm" variant="danger" icon={<X size={14} />} onClick={() => go("cancel", `Cancelled #${t.id}.`)}>Cancel</Button>}
          {!isHosp && next && next !== "AI" && onActAs && <Button size="sm" variant="subtle" onClick={() => onActAs(next)}>Act as {next}</Button>}
          <Button size="sm" variant="ghost" icon={<MessageSquare size={14} />} onClick={() => setOpen(!open)}>Thread</Button>
        </div>
      </div>
      {t.status in STEP && <div className="mt-3"><Stepper steps={["Proposed", "Agreed", "In transit", "Delivered"]} current={STEP[t.status]} /></div>}
      {open && <Thread id={t.id} actor={actor} version={version} act={act} names={names} />}
    </li>
  );
}

function Thread({ id, actor, version, act, names }: { id: number; actor: string; version: number; act: Act; names: Names }) {
  const t = useApi(() => get<Board>("/exchange"), [version]);
  const [text, setText] = useState("");
  const tr = t.data?.transfers.find((x) => x.id === id);
  const msgs = (t.data?.messages ?? []).filter((m) => m.transfer_id === id).slice().reverse();
  const canWrite = actor !== "NET" && !!tr && (actor === tr.from_id || actor === tr.to_id);
  return (
    <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs">
      {tr && <p className="mb-2 text-muted">{tr.reason} Batches: {tr.allocations.map((a) => `${a.batch_id} ×${a.qty}`).join(", ")}</p>}
      <div className="space-y-1">{msgs.map((m) => <p key={m.id}><b>{names.hn(m.sender)}:</b> {m.body}</p>)}</div>
      {canWrite && tr && (
        <div className="mt-2 flex gap-2">
          <Input className="h-9 flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the other hospital…" />
          <Button size="sm" disabled={!text.trim()} onClick={() => act(() => post("/messages", {
            sender: actor, recipient: actor === tr.from_id ? tr.to_id : tr.from_id, body: text, transfer_id: id,
          }), "Message sent").then(() => setText(""))}>Send</Button>
        </div>
      )}
    </div>
  );
}
