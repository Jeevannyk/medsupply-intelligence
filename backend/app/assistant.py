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

SYSTEM = ("You are the Medical Supply Intelligence assistant for a network of 8 hospitals. "
          "Answer hospital administrators in plain language. ALWAYS call tools to get data and ONLY use numbers "
          "returned by tools; never estimate or invent figures. If the tools cannot answer, say so. "
          "Use risk labels exactly as the tools return them (stockout, critical, high, watch); never upgrade or downgrade severity. "
          "Always give days to stock-out and lead time when a tool provides them. "
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
                                              "shortfall_units": s["shortfall"], "substitute": s.get("alternative"),
                                              "substitute_spare_days": s.get("alternative_spare_days")}
                                             for s in an["plan"]["shortfalls"]
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
    def gemini(self, question, scenario, key, model):
        tools = self.tools(scenario)
        contents = [{"role": "user", "parts": [{"text": question}]}]
        used = []
        for _ in range(5):
            body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": contents,
                    "tools": [{"functionDeclarations": self.declarations()}],
                    "generationConfig": {"temperature": 0.2}}
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            content = data["candidates"][0]["content"]
            calls = [p["functionCall"] for p in content.get("parts", []) if "functionCall" in p]
            if not calls:
                text = "".join(p.get("text", "") for p in content.get("parts", []))
                return {"answer": text.strip(), "mode": f"gemini:{model}", "tools": used}
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
                       "\n".join(f"• {'[emergency loan] ' if m['kind'] == 'emergency' else ''}{m['move']}. Why: {m['why']}"
                                  for m in r["moves"][:6]))
                if r["uncovered_shortfalls"]:
                    ans += "\nStill short after transfers: " + "; ".join(
                        f"{s['hospital']} {s['medicine']} {s['shortfall_units']:,}" for s in r["uncovered_shortfalls"])
                if r["supplier_orders"]:
                    ans += "\nTo close the gap, order from the supplier: " + " ".join(r["supplier_orders"][:3])
            elif r["uncovered_shortfalls"]:
                ans = ("No hospital has stock it can safely transfer for that selection, so supplier orders are the fix. "
                       "Still short: " + "; ".join(
                           f"{s['hospital']} {s['medicine']} {s['shortfall_units']:,}"
                           + (f" (substitute: {s['substitute']}, about {s['substitute_spare_days']:.0f} spare days)"
                              if s["substitute"] and s["substitute_spare_days"] >= 3 else "")
                           for s in r["uncovered_shortfalls"]) +
                       ("\nOrders to place today: " + " ".join(r["supplier_orders"][:3]) if r["supplier_orders"] else ""))
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
            if r["risks"]:
                p = call("redistribution_plan", medicine=med, hospital=hosp)
                if p["moves"]:
                    ans += "\nSuggested transfers:\n" + "\n".join(f"• {m['move']}" for m in p["moves"][:3])
                if p["supplier_orders"]:
                    ans += "\nSuggested supplier orders: " + " ".join(p["supplier_orders"][:2])
        return {"answer": ans, "mode": "rules", "tools": used}

    def ask(self, question, scenario="outbreak"):
        key, model = os.environ.get("GEMINI_API_KEY"), os.environ.get("GEMINI_MODEL")
        if key and not model:
            res = self.rules(question, scenario)
            res["note"] = "GEMINI_MODEL is not set in .env; answered from backend data directly."
            return res
        if key:
            try:
                return self.gemini(question, scenario, key, model)
            except Exception as ex:   # fall back to grounded templates
                res = self.rules(question, scenario)
                res["note"] = f"Gemini unavailable ({type(ex).__name__}); answered from backend data directly."
                return res
        return self.rules(question, scenario)

    # ------------------------------------------------- forecast chart analysis
    ANALYZE_SYSTEM = (
        "You explain a hospital medicine-demand chart to a busy, non-technical hospital administrator. "
        "Use ONLY the numbers in the facts JSON; never invent, recompute or round differently. "
        "Use everyday words: say 'likely range' not 'P10-P90', 'sudden jump' not 'anomaly', 'runs out' not 'stock-out'. "
        "Use risk labels exactly as given. Maximum 100 words. "
        "Answer in exactly three markdown bullets that start with these bold labels, one or two short sentences each: "
        "**What happened**, **What to expect**, **What to do**. "
        "If stock information is present, use it in **What to do**; otherwise say what the administrator should watch."
    )

    def forecast_facts(self, scenario, medicine, hospital) -> dict:
        """Everything the chart shows, reduced to a few numbers. All arithmetic happens here, not in the LLM."""
        e = self.e
        med = e.M[medicine]
        s = e.series(scenario, medicine, hospital)
        hist, fut = s["history"], s["forecast"]
        actual = [p["actual"] for p in hist]
        avg = lambda xs: sum(xs) / len(xs) if xs else 0.0
        last7, base = avg(actual[-7:]), avg(actual[-35:-7])
        peak = max(hist, key=lambda p: p["actual"])
        jumps = [p for p in hist if p["anomaly"]]
        p50 = sum(f["p50"] for f in fut)
        busiest = max(fut, key=lambda f: f["p50"])
        facts = {
            "scope": "the whole hospital network" if hospital == "ALL" else e.H[hospital]["name"],
            "medicine": med["name"], "unit": med["unit"],
            "data_shown": "after the outbreak (current data)" if scenario == "outbreak" else "no-outbreak comparison data",
            "chart_window_days": len(hist),
            "average_per_day_last_7_days": round(last7),
            "average_per_day_in_the_4_weeks_before": round(base),
            "change_last_week_vs_before_percent": round((last7 / base - 1) * 100) if base else None,
            "highest_day_in_chart": {"date": peak["date"], "units": peak["actual"]},
            "unusually_high_days_marked_red": len(jumps),
            "system_flagged_a_sudden_jump_on": s["detected_date"] if s["spike"] else None,
            "outbreak_began_on": s["outbreak_start"] if s["spike"] else None,
            "forecast_next_7_days_total": s["next_7d"],
            "forecast_next_14_days_total": s["next_14d"],
            "forecast_average_per_day": round(p50 / len(fut)) if fut else None,
            "forecast_vs_last_week_percent": round((p50 / len(fut) / last7 - 1) * 100) if last7 and fut else None,
            "forecast_busiest_day": {"date": busiest["date"], "units": round(busiest["p50"])},
            "units_added_by_outbreak_adjustment_over_14_days": round(p50 - sum(f["gbm"] for f in fut)),
        }
        a = e.analysis(scenario)
        if hospital != "ALL":
            c = next(c for c in a["cells"] if c["hospital"] == hospital and c["medicine"] == medicine)
            facts["stock_now"] = {"units_in_stock": c["stock"], "days_until_it_runs_out": c["days_to_stockout"],
                                  "supplier_lead_time_days": c["lead_days"], "risk": c["risk"],
                                  "units_that_will_expire_unused": c["projected_waste"]}
        else:
            risky = [c for c in a["cells"] if c["medicine"] == medicine and c["risk"] in ("stockout", "critical", "high")]
            facts["hospitals_at_risk_for_this_medicine"] = [
                {"hospital": e.H[c["hospital"]]["name"], "days_until_it_runs_out": c["days_to_stockout"],
                 "supplier_lead_time_days": c["lead_days"], "risk": c["risk"]} for c in risky[:4]] or "none"
        return facts

    @staticmethod
    def _analysis_from_facts(f: dict) -> str:
        """Plain-text version of the same four bullets, used when Gemini is not configured or fails."""
        u, ch = f["unit"], f["change_last_week_vs_before_percent"]
        trend = "about the same as" if ch is None or abs(ch) < 5 else f"{abs(ch)}% {'higher' if ch > 0 else 'lower'} than"
        happened = (f"**What happened** · {f['scope']} used about {f['average_per_day_last_7_days']:,} {u} of {f['medicine']} a day over the last week, "
                    f"{trend} the four weeks before.")
        if f["system_flagged_a_sudden_jump_on"]:
            happened += f" The system flagged a sudden jump on {f['system_flagged_a_sudden_jump_on']}."
        expect = (f"**What to expect** · about {f['forecast_next_7_days_total']:,} {u} over the next 7 days and {f['forecast_next_14_days_total']:,} over 14 days, "
                  f"busiest around {f['forecast_busiest_day']['date']}.")
        sn = f.get("stock_now")
        if sn:
            d, lead = sn["days_until_it_runs_out"], sn["supplier_lead_time_days"]
            if d is not None and d < lead:
                todo = f"**What to do** · stock runs out in about {int(d)} days but a resupply takes {lead} days, so ask other hospitals for stock now and order today."
            elif d is not None and d < lead + 7:
                todo = f"**What to do** · stock lasts about {int(d)} days against a {lead}-day resupply, so plan the next order soon."
            else:
                todo = f"**What to do** · stock ({sn['units_in_stock']:,} {u}) comfortably covers the resupply time; keep watching the forecast."
        else:
            risky = f.get("hospitals_at_risk_for_this_medicine")
            todo = ("**What to do** · no hospital is short of this medicine right now; keep watching the forecast." if risky == "none"
                    else "**What to do** · check these hospitals first: " + "; ".join(f"{r['hospital']} ({r['days_until_it_runs_out']} days left, resupply {r['supplier_lead_time_days']} days)" for r in risky) + ".")
        return "\n".join(f"* {x}" for x in (happened, expect, todo))

    def analyze_forecast(self, scenario, medicine, hospital) -> dict:
        facts = self.forecast_facts(scenario, medicine, hospital)
        out = {"scope": facts["scope"], "medicine": facts["medicine"]}
        key, model = os.environ.get("GEMINI_API_KEY"), os.environ.get("GEMINI_MODEL")
        if not key:
            return out | {"analysis": self._analysis_from_facts(facts), "mode": "rules",
                          "note": "Add GEMINI_API_KEY and GEMINI_MODEL to backend/.env for an AI-written analysis."}
        if not model:
            return out | {"analysis": self._analysis_from_facts(facts), "mode": "rules",
                          "note": "GEMINI_MODEL is not set in .env; showing the built-in analysis."}
        try:
            body = {"systemInstruction": {"parts": [{"text": self.ANALYZE_SYSTEM}]},
                    "contents": [{"role": "user", "parts": [{"text": "Facts about the chart:\n" + json.dumps(facts, indent=1)}]}],
                    "generationConfig": {"temperature": 0.3, "maxOutputTokens": 600}}
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            text = "".join(p.get("text", "") for p in data["candidates"][0]["content"].get("parts", [])).strip()
            if not text:
                raise ValueError("empty answer")
            return out | {"analysis": text, "mode": f"gemini:{model}"}
        except Exception as ex:   # never leave the button without an answer
            return out | {"analysis": self._analysis_from_facts(facts), "mode": "rules",
                          "note": f"Gemini unavailable ({type(ex).__name__}); showing the built-in analysis."}
