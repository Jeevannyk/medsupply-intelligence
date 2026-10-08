import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, HandCoins, Inbox, Megaphone, PackageCheck, Truck, type LucideIcon } from "lucide-react";
import { get, useApi, type Board } from "../api";
import { useApp } from "../context";
import { go } from "../router";
import { fmt } from "./ui";

type Kind = "proposal" | "request" | "offer" | "dispatch" | "receive";
interface Note { key: string; kind: Kind; mine: boolean; title: string; sub: string; time: string; tab: "inbox" | "transfers" }

const ICON: Record<Kind, { icon: LucideIcon; tone: string }> = {
  proposal: { icon: Inbox, tone: "bg-amber-100 text-amber-700" },
  request: { icon: HandCoins, tone: "bg-rose-100 text-rose-700" },
  offer: { icon: Megaphone, tone: "bg-teal-100 text-teal-700" },
  dispatch: { icon: Truck, tone: "bg-indigo-100 text-indigo-700" },
  receive: { icon: PackageCheck, tone: "bg-emerald-100 text-emerald-700" },
};

/** Same rules as the Hospital exchange page, so the badge always matches what is waiting there. */
function build(actor: string, b: Board, hn: (id: string) => string, mn: (id: string) => string, unit: (id: string) => string): Note[] {
  const q = (n: number, med: string) => `${fmt(n)} ${unit(med)} of ${mn(med)}`;
  const t = (iso: string) => iso.slice(11, 16);
  const openReq = b.requests.filter((r) => r.status === "open");
  const openOff = b.offers.filter((o) => o.status === "open");
  const out: Note[] = [];

  if (actor === "NET") {                                       // admin: read-only overview of what hospitals have posted
    for (const r of openReq) out.push({ key: `r${r.id}`, kind: "request", mine: false, title: `${hn(r.hospital_id)} requested ${q(r.remaining, r.medicine_id)}`, sub: `Needed within ${r.needed_within_days} days${r.target ? ` · addressed to ${hn(r.target)}` : " · open to all hospitals"}`, time: t(r.created_at), tab: "inbox" });
    for (const o of openOff) out.push({ key: `o${o.id}`, kind: "offer", mine: false, title: `${hn(o.hospital_id)} is offering ${q(o.remaining, o.medicine_id)}`, sub: `Expires ${o.expiry_date}${o.target ? ` · addressed to ${hn(o.target)}` : " · open to all hospitals"}`, time: t(o.created_at), tab: "inbox" });
    return out;
  }

  for (const x of b.transfers.filter((x) => x.status === "pending" && x.awaiting === actor))
    out.push({ key: `t${x.id}`, kind: "proposal", mine: true, title: `Network proposal: send ${q(x.qty, x.medicine_id)} to ${hn(x.to_id)}`, sub: "Approve or decline", time: t(x.updated_at), tab: "inbox" });
  for (const r of openReq.filter((r) => r.target === actor))
    out.push({ key: `r${r.id}`, kind: "request", mine: true, title: `${hn(r.hospital_id)} asked you for ${q(r.remaining, r.medicine_id)}`, sub: `Needed within ${r.needed_within_days} days · addressed to you`, time: t(r.created_at), tab: "inbox" });
  for (const o of openOff.filter((o) => o.target === actor))
    out.push({ key: `o${o.id}`, kind: "offer", mine: true, title: `${hn(o.hospital_id)} offered you ${q(o.remaining, o.medicine_id)}`, sub: `Expires ${o.expiry_date} · addressed to you`, time: t(o.created_at), tab: "inbox" });
  for (const x of b.transfers.filter((x) => x.status === "approved" && x.from_id === actor))
    out.push({ key: `d${x.id}`, kind: "dispatch", mine: true, title: `Dispatch ${q(x.qty, x.medicine_id)} to ${hn(x.to_id)}`, sub: `Transfer #${x.id} agreed, ready to send`, time: t(x.updated_at), tab: "transfers" });
  for (const x of b.transfers.filter((x) => x.status === "in_transit" && x.to_id === actor))
    out.push({ key: `v${x.id}`, kind: "receive", mine: true, title: `Confirm receipt of ${q(x.qty, x.medicine_id)} from ${hn(x.from_id)}`, sub: `Transfer #${x.id} is on its way`, time: t(x.updated_at), tab: "transfers" });
  for (const r of openReq.filter((r) => !r.target && r.hospital_id !== actor))
    out.push({ key: `r${r.id}`, kind: "request", mine: false, title: `${hn(r.hospital_id)} requested ${q(r.remaining, r.medicine_id)}`, sub: `Needed within ${r.needed_within_days} days · open to all hospitals`, time: t(r.created_at), tab: "inbox" });
  for (const o of openOff.filter((o) => !o.target && o.hospital_id !== actor))
    out.push({ key: `o${o.id}`, kind: "offer", mine: false, title: `${hn(o.hospital_id)} is offering ${q(o.remaining, o.medicine_id)}`, sub: `Expires ${o.expiry_date} · open to all hospitals`, time: t(o.created_at), tab: "inbox" });
  return out;
}

export default function NotificationBell() {
  const { actor, version, names } = useApp();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [ring, setRing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const prev = useRef<number | null>(null);

  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 6000); return () => clearInterval(t); }, []);   // pick up posts made elsewhere
  const board = useApi(() => get<Board>("/exchange", { hospital: actor === "NET" ? undefined : actor }), [actor, version, tick]);
  const notes = board.data ? build(actor, board.data, names.hn, names.mn, names.unit) : [];
  const count = notes.length;

  useEffect(() => {                                            // ring the bell when something new arrives
    if (!board.data) return;
    if (prev.current !== null && count > prev.current) { setRing(true); const t = setTimeout(() => setRing(false), 800); return () => clearTimeout(t); }
    prev.current = count;
  }, [count, board.data]);
  useEffect(() => { prev.current = null; }, [actor]);          // switching role is not "new" news

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  const openExchange = (tab: "inbox" | "transfers") => {
    try { sessionStorage.setItem("exchangeTab", tab); } catch { /* storage unavailable: land on the default tab */ }
    setOpen(false);
    go("/exchange");
    window.dispatchEvent(new CustomEvent("exchange-tab", { detail: tab }));
  };
  const who = actor === "NET" ? "Network admin (read-only)" : names.hn(actor);
  const urgent = notes.filter((n) => n.mine).length;

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-label={`Notifications${count ? `, ${count} waiting` : ""}`} aria-expanded={open}
        className={`pressable relative grid size-10 place-items-center rounded-xl border border-line bg-white text-slate-600 shadow-sm transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink ${open ? "border-brand/40 bg-brand-soft text-brand-ink" : ""}`}>
        <Bell size={18} className={ring ? "bell-ring" : ""} />
        {count > 0 && (
          <span className="num absolute -top-1.5 -right-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-red-600 px-1 text-[10px] leading-none font-bold text-white ring-2 ring-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Notifications" className="rise absolute top-12 right-0 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-white shadow-2xl">
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Notifications</h2>
              <span className="text-xs text-muted">{count === 0 ? "All caught up" : `${count} waiting`}</span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted">For {who}{actor !== "NET" && urgent > 0 ? ` · ${urgent} need${urgent === 1 ? "s" : ""} your action` : ""}</p>
          </div>
          <div className="scroll-thin max-h-[min(26rem,60vh)] overflow-y-auto">
            {count === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted">
                <Bell className="mx-auto mb-2 text-slate-300" size={26} />
                No requests or offers are waiting.
              </div>
            ) : notes.map((n) => {
              const { icon: Icon, tone } = ICON[n.kind];
              return (
                <button key={n.key} onClick={() => openExchange(n.tab)}
                  className="flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-0 hover:bg-slate-50">
                  <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${tone}`}><Icon size={15} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-5 font-semibold text-ink">{n.title}</span>
                    <span className="block text-xs leading-4 text-muted">{n.sub}</span>
                  </span>
                  <span className="num shrink-0 pt-0.5 text-[11px] text-slate-400">{n.time}</span>
                </button>
              );
            })}
          </div>
          <button onClick={() => openExchange("inbox")}
            className="flex w-full items-center justify-center gap-1.5 border-t border-line bg-slate-50 px-4 py-2.5 text-xs font-semibold text-brand-ink transition-colors hover:bg-brand-soft">
            Open Hospital exchange <ArrowRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
