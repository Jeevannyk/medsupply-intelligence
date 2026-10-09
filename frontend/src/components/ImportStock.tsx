import { useRef, useState } from "react";
import { ArrowRight, Check, Download, FileUp, X } from "lucide-react";
import { post } from "../api";
import { useApp } from "../context";
import { Button, Card, Pill, fmt } from "./ui";

interface ImportResult {
  ok: boolean; applied: boolean; more_errors: number;
  errors: { row: number | null; message: string }[];
  summary: null | { rows: number; hospitals: string[]; batches_replaced: number; units_before: number; units_after: number;
    changes: { hospital: string; medicine: string; before: number; after: number }[] };
}

/** Replace a hospital's stock with the batches in a CSV: check first (preview), change only when the user confirms. */
export function ImportStock({ onClose }: { onClose: () => void }) {
  const { actor, names, act } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const allowed = actor === "NET" || (actor !== "DIST" && !!actor);

  const check = async (text: string) => {
    setBusy(true); setProblem(null); setRes(null);
    try { setRes(await post<ImportResult>("/import/stock", { csv: text, actor, apply: false })); } catch (e) { setProblem((e as Error).message); }
    setBusy(false);
  };
  const choose = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_000_000) { setFile(null); setRes(null); setProblem("That file is larger than 1 MB. Split it by hospital."); return; }
    const text = await f.text();
    setFile({ name: f.name, text });
    await check(text);
    if (input.current) input.current.value = "";            // allow choosing the same file again after editing it
  };
  const apply = () => file && act(async () => {
    const r = await post<ImportResult>("/import/stock", { csv: file.text, actor, apply: true });
    if (!r.applied) throw new Error(r.errors[0]?.message ?? "The import was not applied.");
    onClose();
    return r;
  }, (r: ImportResult) => `Stock imported: ${fmt(r.summary!.rows)} batches, ${r.summary!.hospitals.join(", ")} updated. Risk and the plan are recalculated.`);

  const s = res?.summary;
  return (
    <Card title="Import stock from a CSV" icon={<FileUp size={18} />}
      subtitle="Replace a hospital's stock with its real batch records. Nothing changes until you confirm the preview."
      actions={<Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onClose}>Close</Button>}>
      <div className="space-y-4 text-sm">
        {!allowed ? (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">The district office does not hold hospital stock. Switch "Acting as" to a hospital, or the network admin.</p>
        ) : (
          <>
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-muted">
              Importing as <b className="text-ink">{names.hn(actor)}</b>. {actor === "NET" ? "You can import any hospital's stock." : "You can import only this hospital's own stock."}
              {" "}The file replaces <b>all</b> stock of every hospital it contains. Columns: <code>hospital_id, medicine_id, batch_id</code> (optional), <code>qty, expiry_date</code> (YYYY-MM-DD).
              Only current stock is imported; the demand history behind the forecast is unchanged.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <a href="/api/import/stock/export" download="current_stock.csv"
                className="pressable inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink shadow-sm hover:border-brand/40 hover:bg-brand-soft">
                <Download size={14} />1 · Download current stock (template)
              </a>
              <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
              <Button size="sm" icon={<FileUp size={14} />} loading={busy} onClick={() => input.current?.click()}>2 · Choose your CSV</Button>
              {file && <span className="text-xs text-muted">{file.name}</span>}
            </div>

            {problem && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-red-800">{problem}</p>}

            {res && !res.ok && (
              <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">
                <p className="font-semibold">Not imported. Fix these and choose the file again:</p>
                <ul className="mt-2 space-y-1 text-xs leading-5">
                  {res.errors.map((e, i) => <li key={i}>{e.row !== null ? <b>Row {e.row}: </b> : null}{e.message}</li>)}
                  {res.more_errors > 0 && <li>…and {res.more_errors} more.</li>}
                </ul>
              </div>
            )}

            {res?.ok && s && (
              <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                <p className="font-semibold text-emerald-900">The file is valid. {fmt(s.rows)} batches for {s.hospitals.map((h) => names.hn(h)).join(", ")}.</p>
                <p className="text-xs text-muted">Units in those hospitals: <b className="num text-ink">{fmt(s.units_before)}</b> <ArrowRight size={11} className="inline" /> <b className="num text-ink">{fmt(s.units_after)}</b>. {s.batches_replaced} existing batches are replaced.</p>
                {s.changes.length === 0 ? <p className="text-xs text-muted">No quantities differ from what the app holds now.</p> : (
                  <table className="num w-full text-xs">
                    <thead><tr className="text-left text-muted"><th className="py-1">Hospital</th><th>Medicine</th><th>Now</th><th>After import</th></tr></thead>
                    <tbody>
                      {s.changes.slice(0, 12).map((c) => (
                        <tr key={`${c.hospital}${c.medicine}`} className="border-t border-emerald-100">
                          <td className="py-1 font-medium">{c.hospital}</td><td>{names.mn(c.medicine)}</td><td>{fmt(c.before)}</td>
                          <td><b className={c.after < c.before ? "text-red-700" : "text-emerald-700"}>{fmt(c.after)}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {s.changes.length > 12 && <p className="text-xs text-muted">…and {s.changes.length - 12} more changes.</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="success" icon={<Check size={15} />} onClick={apply}>Apply import</Button>
                  <Button variant="ghost" onClick={() => { setFile(null); setRes(null); }}>Discard</Button>
                  <Pill tone="amber">replaces stock, risk and plan are recalculated</Pill>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
