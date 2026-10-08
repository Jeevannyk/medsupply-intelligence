"""Supply assistant. Every number comes from backend tools; the LLM only phrases.

With GEMINI_API_KEY set, Gemini (free tier) picks tools via function calling and
writes the answer from their results. Without a key, or if the API fails, a
rule-based router calls the same tools and fills answer templates.
"""
import json
import os
import re
import urllib.request

from .engine import Engine

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
SYSTEM = ("You are the Medical Supply Intelligence assistant for a network of 8 hospitals. "
          "Answer hospital administrators in plain language. ALWAYS call tools to get data and ONLY use numbers "
          "returned by tools; never estimate or invent figures. If the tools cannot answer, say so. "
          "Be concise (under 150 words), lead with the answer, use short bullet points for lists, "
          "and name hospitals by name and letter, e.g. 'City General Hospital (A)'.")

MED_ALIASES = {
    "OSEL": ["oseltamivir", "tamiflu", "osel", "antiviral", "flu medicine"],
    "CEFT": ["ceftriaxone", "ceft", "rocephin"],
    "AMOX": ["amoxicillin", "amox", "augmentin", "clavulanate"],
    "INSU": ["insulin", "glargine", "insu"],
    "SALB": ["salbutamol", "albuterol", "nebul", "salb"],
    "ORS": ["ors", "oral rehydration"],
}


class Assistant:
    def __init__(self, engine: Engine):
        self.e = engine

    # -------------------------------------------------------------- tools
    def tools(self, scenario):
        e = self.e

        def a():
            return e.analysis(scenario)

        def hn(h):
            return f"{e.H[h]['name']} ({h})"

        def shortage_risks(days: int = 7, medicine: str | None = None, hospital: str | None = None):
            out = []
            for c in a()["cells"]:
                if medicine and c["medicine"] != medicine or hospital and c["hospital"] != hospital:
                    continue
                d = c["days_to_stockout"]
                if d is not None and d <= days or c["risk"] in ("stockout", "critical", "high"):
                    out.append({"hospital": hn(c["hospital"]), "medicine": e.M[c["medicine"]]["name"],
                                "days_to_stockout": d, "lead_time_days": c["lead_days"], "risk": c["risk"],
                                "priority_score": c["priority"]["score"], "warning": c["message"]})
            return {"within_days": days, "count": len(out), "risks": out[:12]}

        def expiry_risks(medicine: str | None = None, hospital: str | None = None):
            rows = [x for x in a()["expiry"] if (not medicine or x["medicine"] == medicine)
                    and (not hospital or x["hospital"] == hospital)]
            return {"total_units_at_risk": sum(x["projected_waste"] for x in rows),
                    "total_value_inr": sum(x["value"] for x in rows),
                    "batches": [{"hospital": hn(x["hospital"]), "medicine": e.M[x["medicine"]]["name"],
                                 "batch": x["batch_id"], "expires": x["expiry_date"],
                                 "units_wasted": x["projected_waste"], "reason": x["reason"]} for x in rows]}

        def redistribution_plan(medicine: str | None = None, hospital: str | None = None):
            an = a()
            mv = [m for m in an["plan"]["moves"] if (not medicine or m["medicine"] == medicine)
                  and (not hospital or hospital in (m["from"], m["to"]))]
            return {"moves": [{"id": m["id"], "move": m["text"], "kind": m["kind"], "why": m["reason"]} for m in mv],
                    "units_moved": sum(m["qty"] for m in mv),
                    "verified": an["verification"]["passed"],
                    "checks": [c["name"] for c in an["verification"]["checks"] if c["passed"]],
                    "uncovered_shortfalls": [{"hospital": hn(s["hospital"]), "medicine": e.M[s["medicine"]]["name"],
                                              "shortfall_units": s["shortfall"]} for s in an["plan"]["shortfalls"]
                                             if (not medicine or s["medicine"] == medicine)],
                    "supplier_orders": [o["text"] for o in an["orders"] if (not medicine or o["medicine"] == medicine)]}

        def priority_ranking(medicine: str = "CEFT"):
            cells = sorted((c for c in a()["cells"] if c["medicine"] == medicine),
                           key=lambda c: -c["priority"]["score"])
            return {"medicine": e.M[medicine]["name"],
                    "ranking": [{"hospital": hn(c["hospital"]), "score": c["priority"]["score"],
                                 "contributions": c["priority"]["contributions"], "need_units": c["need"],
                                 "explanation": c["priority"]["explanation"]} for c in cells]}

        def hospital_summary(hospital: str):
            d = e.hospital_detail(scenario, hospital)
            return {"hospital": hn(hospital), "patients_per_day": d["hospital"]["patient_load"],
                    "medicines": [{"medicine": e.M[c["medicine"]]["name"], "stock": c["stock"],
                                   "days_to_stockout": c["days_to_stockout"], "risk": c["risk"]} for c in d["cells"]],
                    "transfers": [m["text"] for m in d["moves"]], "orders": [o["text"] for o in d["orders"]],
                    "expiring": [x["reason"] for x in d["expiry"]]}

        def outbreak_signals():
            sp = a()["spikes"]
            return {"count": len(sp), "signals": [{"hospital": hn(s["hospital"]), "medicine": e.M[s["medicine"]]["name"],
                                                   "demand_vs_baseline": s["surge"], "detected": s["detected_date"]}
                                                  for s in sp]}

        def demand_forecast(medicine: str, hospital: str | None = None, days: int = 7):
            s = e.series(scenario, medicine, hospital or "ALL")
            days = max(1, min(int(days), 14))
            return {"medicine": e.M[medicine]["name"], "scope": hn(hospital) if hospital else "whole network",
                    "days": days, "forecast_units": int(round(sum(f["p50"] for f in s["forecast"][:days]))),
                    "low_p10": int(round(sum(f["p10"] for f in s["forecast"][:days]))),
                    "high_p90": int(round(sum(f["p90"] for f in s["forecast"][:days]))),
                    "last_weeks_actual": [w["units"] for w in s["weekly"][-5:]], "spike_detected": s["spike"]}

        def judge_scenario():
            j = e.judge(scenario)
            return {k: j[k] for k in ("statement", "stock_total", "weekly_demand", "aggregate_cover_days", "passed")} | {
                "moves": [m["text"] for m in j["moves"]]}

        return {f.__name__: f for f in (shortage_risks, expiry_risks, redistribution_plan, priority_ranking,
                                        hospital_summary, outbreak_signals, demand_forecast, judge_scenario)}

    DECLS = [
        ("shortage_risks", "Hospitals/medicines that run out within N days, with lead times and warnings.",
         {"days": "integer", "medicine": "string", "hospital": "string"}),
        ("expiry_risks", "Stock batches projected to expire unused, with reasoning.", {"medicine": "string", "hospital": "string"}),
        ("redistribution_plan", "Recommended inter-hospital transfers, verification, shortfalls and supplier orders.",
         {"medicine": "string", "hospital": "string"}),
        ("priority_ranking", "Priority scores and factor breakdown of hospitals competing for one medicine.",
         {"medicine": "string"}),
        ("hospital_summary", "Stock, risks, transfers and orders for one hospital.", {"hospital": "string"}),
        ("outbreak_signals", "Detected demand spikes / outbreak signals.", {}),
        ("demand_forecast", "Forecast demand for a medicine over the next N days (network or one hospital).",
         {"medicine": "string", "hospital": "string", "days": "integer"}),
        ("judge_scenario", "The 20,000-unit Oseltamivir sample scenario check.", {}),
    ]

    def declarations(self):
        enum_note = " Medicine ids: OSEL, CEFT, AMOX, INSU, SALB, ORS. Hospital ids: A-H."
        out = []
        for name, desc, params in self.DECLS:
            decl = {"name": name, "description": desc + enum_note}
            if params:
                decl["parameters"] = {"type": "OBJECT", "properties": {
                    k: {"type": t.upper()} for k, t in params.items()}}
            out.append(decl)
        return out

    # ------------------------------------------------------------- gemini
    def gemini(self, question, scenario, key):
        tools = self.tools(scenario)
        contents = [{"role": "user", "parts": [{"text": question}]}]
        used = []
        for _ in range(5):
            body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": contents,
                    "tools": [{"functionDeclarations": self.declarations()}],
                    "generationConfig": {"temperature": 0.2}}
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            content = data["candidates"][0]["content"]
            calls = [p["functionCall"] for p in content.get("parts", []) if "functionCall" in p]
            if not calls:
                text = "".join(p.get("text", "") for p in content.get("parts", []))
                return {"answer": text.strip(), "mode": f"gemini:{GEMINI_MODEL}", "tools": used}
            contents.append(content)
            parts = []
            for call in calls:
                args = self.normalise(call.get("args", {}))
                result = tools[call["name"]](**args) if call["name"] in tools else {"error": "unknown tool"}
                used.append({"name": call["name"], "args": args, "result": result})
                parts.append({"functionResponse": {"name": call["name"], "response": {"result": result}}})
            contents.append({"role": "user", "parts": parts})
        raise RuntimeError("tool loop did not finish")

    def normalise(self, args):
        out = {}
        for k, v in args.items():
            if k == "medicine" and v:
                out[k] = self.find_medicine(str(v)) or str(v).upper()
            elif k == "hospital" and v:
                out[k] = self.find_hospital(str(v)) or str(v).upper()[:1]
            elif k == "days":
                out[k] = int(v)
            else:
                out[k] = v
        return out

    # -------------------------------------------------------------- rules
    def find_medicine(self, q):
        q = q.lower()
        for m, al in MED_ALIASES.items():
            if m.lower() == q or any(re.search(rf"\b{re.escape(a)}", q) for a in al):
                return m
        return None

    def find_hospital(self, q):
        ql = q.lower()
        m = re.search(r"\bhospital\s+([a-h])\b", ql) or re.fullmatch(r"\s*([a-h])\s*", ql) or re.search(r"\(([a-h])\)", ql)
        if m:
            return m.group(1).upper()
        for h in self.e.hospitals:
            keys = [h["name"].lower(), h["city"].lower(), h["name"].lower().split()[0]]
            if h["id"] == "E":
                keys += ["children", "riverside", "paediatric", "pediatric"]
            if h["id"] == "B":
                keys += ["st mary", "st. mary"]
            if any(k and len(k) > 3 and k in ql for k in keys):
                return h["id"]
        return None

    @staticmethod
    def find_days(q):
        ql = q.lower()
        m = re.search(r"(\d+)\s*day", ql)
        if m:
            return int(m.group(1))
        if "tomorrow" in ql:
            return 1
        if "two weeks" in ql or "fortnight" in ql or "14" in ql:
            return 14
        return 7

    def rules(self, question, scenario):
        t = self.tools(scenario)
        q = question.lower()
        med, hosp, days = self.find_medicine(q), self.find_hospital(question), self.find_days(q)
        used = []

        def call(name, **kw):
            kw = {k: v for k, v in kw.items() if v is not None}
            r = t[name](**kw)
            used.append({"name": name, "args": kw, "result": r})
            return r

        if any(w in q for w in ("20,000", "20000", "judge", "sample scenario")):
            r = call("judge_scenario")
            ans = r["statement"] + "\n" + "\n".join(f"• {m}" for m in r["moves"])
        elif any(w in q for w in ("expir", "waste", "wastage")):
            r = call("expiry_risks", medicine=med, hospital=hosp)
            ans = (f"{r['total_units_at_risk']:,} units (₹{r['total_value_inr']:,}) are projected to expire unused:\n" +
                   "\n".join(f"• {b['hospital']}: {b['reason']}" for b in r["batches"][:6])) if r["batches"] else \
                "No batches are projected to expire unused."
        elif any(w in q for w in ("priorit", "who gets", "who should get", "fair", "compete", "scarce")):
            r = call("priority_ranking", medicine=med or "CEFT")
            ans = f"Priority for {r['medicine']} (higher = served first):\n" + "\n".join(
                f"• {x['hospital']}: {x['score']}, {x['explanation'].split(': ', 1)[-1]}" for x in r["ranking"][:5])
        elif any(w in q for w in ("move", "redistribut", "transfer", "send", "why", "plan", "excess", "surplus")):
            r = call("redistribution_plan", medicine=med, hospital=hosp)
            if r["moves"]:
                ans = (f"Recommended transfers ({r['units_moved']:,} units, verification "
                       f"{'passed' if r['verified'] else 'FAILED'}):\n" +
                       "\n".join(f"• {m['move']}. Why: {m['why']}" for m in r["moves"][:6]))
                if r["uncovered_shortfalls"]:
                    ans += "\nStill short after transfers: " + "; ".join(
                        f"{s['hospital']} {s['medicine']} {s['shortfall_units']:,}" for s in r["uncovered_shortfalls"])
            else:
                ans = "No transfers are needed for that selection."
        elif any(w in q for w in ("outbreak", "spike", "surge", "anomal")):
            r = call("outbreak_signals")
            ans = f"{r['count']} demand spikes detected:\n" + "\n".join(
                f"• {s['hospital']}: {s['medicine']} at {s['demand_vs_baseline']}× baseline (flagged {s['detected']})"
                for s in r["signals"])
        elif any(w in q for w in ("forecast", "how much", "how many", "demand", "need next")) and med:
            r = call("demand_forecast", medicine=med, hospital=hosp, days=days)
            ans = (f"{r['scope']}: expected {r['medicine']} demand over the next {r['days']} days is "
                   f"{r['forecast_units']:,} units (80% range {r['low_p10']:,}–{r['high_p90']:,}). "
                   f"Last weeks: {', '.join(f'{w:,}' for w in r['last_weeks_actual'])}.")
        elif hosp and not any(w in q for w in ("shortage", "run out", "risk", "stock-out", "stockout")):
            r = call("hospital_summary", hospital=hosp)
            risky = [m for m in r["medicines"] if m["risk"] != "ok"]
            ans = (f"{r['hospital']} ({r['patients_per_day']:,} patients/day). " +
                   ("At risk: " + "; ".join(f"{m['medicine']} {m['days_to_stockout']} days ({m['risk']})" for m in risky)
                    if risky else "No medicines at risk.") +
                   ("\nTransfers: " + "; ".join(r["transfers"]) if r["transfers"] else "") +
                   ("\nOrders: " + "; ".join(r["orders"]) if r["orders"] else ""))
        else:
            r = call("shortage_risks", days=days, medicine=med, hospital=hosp)
            ans = (f"{r['count']} hospital-medicine pairs at risk within {days} days:\n" +
                   "\n".join(f"• {x['warning']}" for x in r["risks"][:8])) if r["risks"] else \
                f"No hospital is projected to run out within {days} days."
        return {"answer": ans, "mode": "rules", "tools": used}

    def ask(self, question, scenario="outbreak"):
        key = os.environ.get("GEMINI_API_KEY")
        if key:
            try:
                return self.gemini(question, scenario, key)
            except Exception as ex:   # fall back to grounded templates
                res = self.rules(question, scenario)
                res["note"] = f"Gemini unavailable ({type(ex).__name__}); answered from backend data directly."
                return res
        return self.rules(question, scenario)
