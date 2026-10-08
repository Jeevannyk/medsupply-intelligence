# PRD: Medical Supply Intelligence (Singularity 2026, Track 2)

> "Know before the shortage."

## 1. Brief (from the deck)

**Problem.** Hospitals react to stock-outs after the shelf is empty, while other hospitals sit on stock that will expire. Demand can spike overnight (outbreak).

**Core question.** What is needed, where, when does it run out, and how should limited stock be shared?

**Cross-track winning traits (slide 4).** Prediction (not just detection), explanation in plain words, recommended action, working prototype (simulated data is fine).

### Deliverables required
1. Demand-forecast + shortage-prediction model, per facility and per supply
2. Expiry / wastage risk detection
3. Redistribution engine with clear moves ("Move 1,000 units from B to A")
4. Prioritisation logic for critical supplies under competition
5. Dashboard: Inventory → Predicted Demand → Shortage Risk → Expiry Risk → Redistribution → Priority Facilities
6. Bonus: LLM assistant answering plain questions

### Scoring (100) and where we put effort

| Criterion | Pts | Our angle |
|---|---|---|
| Forecasting & shortage prediction | 25 | Seasonal + outbreak-aware forecast, lead-time-aware "days to stock-out", report MAPE/WAPE vs naive baseline |
| Redistribution quality | 25 | Optimiser (MILP) with hard constraints; **must reconcile on judges' sample scenario** (20,000 units; demand 2,000 → 5,500/wk) |
| Dashboard & decision flow | 15 | One-screen flow, risk colours, facility drill-down |
| Wastage & expiry detection | 10 | Stock vs expected demand before expiry, reasoning shown |
| Critical-supply prioritisation | 10 | Transparent weighted score, adjustable weights, shown trade-offs |
| Innovation & AI assistant | 10 | Anomaly detection + tool-calling LLM that cites computed numbers |
| Demo & storytelling | 5 | With vs without system, outbreak before/after |

**Strategy:** 50% of score is forecast + redistribution. Make those numerically airtight before any polish. The dashboard (15) and demo (5) carry the story, so they must be live and clean, but do not start on them before the engine is correct.

## 2. Product vision and users

**Primary user:** hospital network / district supply administrator, busy, non-technical, needs "what do I do today".
**Secondary:** facility pharmacist (their own stock), judges (verifying numbers).

**One-line pitch:** an early-warning and redistribution copilot that tells an administrator *which hospital runs out of which medicine in how many days, which stock will be wasted, and exactly what to move where, and why.*

## 3. Scope

### In scope (MVP, must ship)
- Synthetic-but-realistic dataset: ~8–12 facilities, ~10–15 supplies (incl. 3–4 critical), 2 years daily history, expiry-dated batches, outbreak events
- Forecast per (facility, supply), 1–4 week horizon with prediction intervals
- Days-to-stock-out incorporating supplier lead time
- Expiry-risk flagging with reasoning
- Redistribution optimiser + priority scoring
- Dashboard with the six-stage flow
- Outbreak scenario toggle (the demo centrepiece)

### Stretch (only after MVP is verified)
- LLM assistant (bonus) with tool-calling over computed tables
- Anomaly/outbreak detector feeding the forecast
- Map view with transport-time routing
- Substitute/alternative-drug logic in prioritisation
- Uncertainty-aware (safety-stock) redistribution

### Out of scope
Real hospital integrations, auth, procurement/purchase ordering, regulatory compliance, mobile app.

## 4. Key assumptions (confirm with organisers if possible)

1. Sample scenario "20,000 units, demand rising 2,000 → 5,500/week" is read as: **network holds 20,000 units of one supply; weekly demand ramps from 2,000 to 5,500**. At 5,500/wk, 20,000 units last ~3.6 weeks if all usable and well-placed. Ramp interpretation, split of stock across hospitals, expiry and lead times are unspecified. We will define them explicitly, document them in the demo, and make them editable in the UI. **Ask the organisers (contact on slide 1) for the exact scenario file/format early.**
2. Data is simulated; judges accept this ("historical or simulated data is fine").
3. Single-tier network (hospitals only, plus one central warehouse as optional supplier node).
4. Software-only; no hardware.

## 5. Functional requirements

### F1. Data layer
- Entities: `facility`, `supply` (criticality tier, shelf life, unit, substitutes), `inventory_batch` (facility, supply, qty, expiry_date), `consumption_daily`, `supplier_lead_time`, `transport_time` (facility↔facility matrix), `events` (outbreaks).
- Generator: base demand × weekly seasonality × yearly seasonality (e.g., monsoon/flu) × facility size + noise + injected outbreak multipliers (ramp then decay). Seeded and reproducible.
- Includes the **exact judge scenario** as a named preset.

### F2. Demand forecasting and shortage risk (25 pts)
- Model per (facility, supply). Baselines first: seasonal-naive, moving average. Main: gradient boosting (LightGBM) on lags, rolling means, day-of-week, season, outbreak signal; quantile outputs (P10/P50/P90). One global model across series with facility/supply features is faster and handles sparse series better.
- Outbreak handling: detect level shift/spike (e.g., rolling z-score or CUSUM on consumption + optional external signal such as "case count"), then scale forecast. Show before/after forecast.
- **Days-to-stock-out** = first day cumulative forecast demand ≥ on-hand usable stock. Run on P50 and P90 (pessimistic).
- **Shortage flag** if `days_to_stockout < supplier_lead_time + safety_buffer`. This is the lead-time-aware warning: "Hospital A runs out of Medicine X in 6 days; resupply takes 9, act now".
- Metrics shown in-app: WAPE/MAPE and bias vs naive baseline on a rolling-origin backtest; interval coverage; a spike-handling example.

### F3. Expiry and wastage risk (10 pts)
- Per batch, FEFO (first-expiry-first-out) consumption simulation against forecast demand.
- `expected_unused_at_expiry` = batch qty − forecast demand drawable before expiry date. Flag if > threshold (e.g., >15% or >X units).
- Show reasoning in one line: "800 units expire 14 Mar; forecast use before then 310; 490 likely wasted".
- Output feeds redistribution as **donor candidates** (surplus that is wasted here but useful elsewhere), the neat link between objectives 2 and 3.

### F4. Redistribution engine (25 pts)
Formulate as MILP / min-cost flow (PuLP or OR-Tools).

- **Decision:** `x[i,j,s,b]` units of supply s (batch b) moved from donor i to recipient j.
- **Hard constraints (feasibility is judged):**
  - Donor never goes below its own protected need (forecast demand over its own lead-time window + safety stock), unless the stock would expire unused anyway.
  - Moved batches must have remaining shelf life > transport time + expected use time at the recipient (no shipping stock that will expire in transit or unused).
  - Arrival time ≤ recipient's days-to-stock-out (otherwise it is too late).
  - Truck/transport capacity and minimum lot size per move.
  - Total moved ≤ available surplus; conservation of units (numbers must add up).
- **Objective (minimise):** weighted sum of unmet critical demand (priority-weighted) + expected wastage + transport cost/time + number of moves.
- **Output:** a clear move list: `Move 1,000 units of X from Hospital B → Hospital A, arrives in 4h, covers A for +5.1 days, avoids 700 units of waste at B`.
- **Reconciliation panel:** before/after table per facility (stock, days of cover, unmet demand, wastage) and a network-level conservation check (`sum in = sum out`, total units unchanged). This is how we beat the judges' "check the numbers add up" test.
- Also report residual shortfall that redistribution can't cover and recommend external procurement / emergency order quantity.

### F5. Critical-supply prioritisation (10 pts)
Transparent score when several hospitals compete for scarce stock:

`priority = w1·criticality_tier + w2·patient_load + w3·emergency_demand + w4·(1/days_to_stockout) − w5·substitute_availability`

- Weights adjustable via sliders; ranking and per-factor contribution bar shown for each facility.
- Rule: life-saving tier gets stock before others (lexicographic tiering) and then weighted score within the tier. Explain trade-offs ("Hospital C ranked 2nd despite lower load because no substitute is on hand").
- Optimiser uses this score as the weight on unmet demand, so ranking and plan stay consistent.

### F6. Dashboard (15 pts)
Single page, left-to-right flow matching slide 12:
1. **Inventory:** per facility/supply on-hand, batches, expiry
2. **Predicted demand:** forecast chart with P10–P90 band and outbreak marker
3. **Shortage risk:** heat-map facility × supply (days to stock-out; red <lead time)
4. **Expiry risk:** wastage-at-risk list, units and value
5. **Redistribution:** move list, before/after, map/arrows
6. **Priority facilities:** ranked list with explanation

Plus: facility drill-down, scenario selector (Normal / Outbreak / Judge scenario), "outbreak start" toggle and slider (demand multiplier), KPI strip (stock-outs avoided, units saved from waste, network days-of-cover).

### F7. AI assistant, bonus (10 pts shared with innovation)
- Tool-calling LLM (Claude API) over the computed tables. **It never invents numbers;** it calls functions like `top_shortage_risks(horizon)`, `explain_move(id)`, `facility_summary(f)` and cites the figures.
- Must answer: "Which hospitals are at highest shortage risk next week?", "Why move stock from B to A?", "What happens if the outbreak doubles?".
- Fallback: canned templated answers if the API is down (demo safety).

### F8. Anomaly detection / innovation
- Isolation Forest or robust-z on consumption residuals to flag outbreak spikes **early** (e.g., 2–3 days before the forecast model fully adapts).
- Optional: auto-generated "daily briefing" paragraph for administrators (LLM over structured output).

## 6. Architecture

```
 synthetic data generator ─▶ SQLite (medsupply.db)
                                │
        ┌───────────────────────┼─────────────────────────┐
        ▼                       ▼                         ▼
  forecast service        expiry/FEFO engine         anomaly detector
  (LightGBM, quantiles)   (batch simulation)         (CUSUM/IsoForest)
        └──────────────┬────────┴──────────────┬──────────┘
                       ▼                       ▼
              shortage risk table      priority scoring
                       └──────────┬────────────┘
                                  ▼
                        redistribution optimiser (MILP)
                                  ▼
                 FastAPI  ◀──▶  LLM assistant (tool calling)
                                  ▼
              React dashboard (Vite + Recharts) via REST/JSON
```

**Stack (decided):**
- **Backend:** FastAPI (Python). ML/optimisation libs live in-process: `pandas`, `lightgbm`, `scikit-learn`, `PuLP`/`ortools`. Pydantic schemas = the interface contract.
- **Database:** SQLite (single file `medsupply.db`, SQLAlchemy or plain `sqlite3`). Generator seeds it; precomputed forecast/risk/expiry/move tables are written back so the API just reads them. Heavy compute (training, MILP) runs as offline/batch scripts or a `POST /recompute` endpoint, never inside a GET.
- **Frontend:** React (Vite + TypeScript), Recharts for charts, Leaflet/MapLibre for the optional map, TanStack Query for fetching, Tailwind for speed.
- **LLM assistant:** FastAPI `/assistant` endpoint, Claude API tool-calling over the same service functions the REST API uses.

Repo layout:
```
/backend   app/ (api, models, services: forecast, expiry, optimiser, priority, anomaly, assistant)
           scripts/ (generate_data.py, train.py, recompute.py)  medsupply.db
/frontend  src/ (pages/Dashboard, components, api client)
```

**API endpoints (draft):**
| Endpoint | Returns |
|---|---|
| `GET /scenarios`, `POST /scenarios/{id}/activate` | list / switch Normal, Outbreak, Judge scenario |
| `GET /inventory?facility=` | on-hand, batches, expiry |
| `GET /forecast?facility=&supply=` | date, p10, p50, p90, outbreak flag |
| `GET /risk` | facility × supply days_to_stockout, lead_time, level, reason |
| `GET /expiry` | at-risk batches, unused units, reason |
| `GET /priority?weights=` | ranked facilities with factor contributions |
| `GET /redistribution` / `POST /redistribution/run` | moves, before/after, ledger checks |
| `GET /kpis` | with vs without simulation results |
| `POST /outbreak` | inject outbreak (multiplier, start) then recompute |
| `POST /assistant` | answer + cited tables |

Frontend is a thin consumer: all numbers come from the API (ledger and reasons included), so the UI can't drift from the engine.

## 7. Data design (summary)

| Table | Key fields |
|---|---|
| facility | id, name, lat/lon, beds, patient_load_index |
| supply | id, name, criticality_tier (1 life-saving … 3 routine), shelf_life_days, unit_cost, substitute_ids |
| inventory_batch | facility_id, supply_id, batch_id, qty, expiry_date |
| consumption_daily | date, facility_id, supply_id, units |
| lead_time | supply_id, supplier_lead_days (+ variance) |
| transport | from_facility, to_facility, hours, capacity_units |
| events | type=outbreak, start, ramp_days, peak_multiplier, decay |

Leakage rule: forecasts for day *t* use only data ≤ *t−1*; backtest by rolling-origin, never random split.

## 8. The judge scenario, worked example (to be implemented exactly)

Define and publish in the app (editable):
- Network: 5 hospitals, one supply ("Medicine X", tier 1), **20,000 units total** at start, spread unevenly (e.g., A 1,500; B 9,000 w/ part near-expiry; C 4,000; D 3,500; E 2,000).
- Network demand ramps **2,000 → 5,500 units/week** over ~4 weeks (outbreak), distributed by facility size/catchment.
- Lead time 7–10 days; transport 2–8 h between sites.
- Expected demonstration: without the system, A and E stock out in ~week 1–2 while B wastes expiring units; with the system, moves cover A/E in time, B's near-expiry stock is used, and residual shortfall (since 20,000 < cumulative demand over the ramp) is quantified with an emergency-procurement recommendation.
- On-screen **ledger** proves: units before = units after; no moved batch expires in transit; every move arrives before recipient stock-out.

Sanity check to build as a unit test: cumulative network demand over the ramp vs. 20,000 supply, and total moved ≤ total surplus.

## 9. Evaluation and test plan

| Area | Check | Target |
|---|---|---|
| Forecast | WAPE vs seasonal-naive on rolling backtest | Beat baseline by a clear margin (≥15% target), report honestly |
| Intervals | P10–P90 coverage | ~80% |
| Spike | Detection lag on injected outbreaks | ≤ 3 days |
| Stock-out | Predicted vs simulated true stock-out day | MAE ≤ 1–2 days |
| Expiry | Precision/recall of flagged batches vs simulated ground truth | Report both |
| Optimiser | Constraint unit tests (conservation, expiry-in-transit, arrival-before-stockout, capacity) | All pass |
| Optimiser value | Simulate 6 weeks with vs without plan: stock-out days, wasted units | Clear improvement, shown as headline KPI |
| Assistant | 10 canned questions answered with numbers matching tables | 10/10 |

## 10. Plan and milestones

Assumed hackathon length ~24–36 h; scale proportionally. Team of 3–4: **Data/ML**, **Optimisation**, **Dashboard**, **Pitch/LLM** (floating).

| Phase | Time | Output | Owner |
|---|---|---|---|
| 0. Align | 0–1 h | Confirm scenario assumptions with organisers, repo, schema, who owns what | All |
| 1. Data | 1–4 h | Generator + judge-scenario preset + SQLite/Parquet | Data/ML |
| 2. Forecast + stock-out | 4–10 h | Baseline then LightGBM, days-to-stockout, backtest metrics | Data/ML |
| 2b. Expiry/FEFO | 4–8 h (parallel) | Wastage flags + reasoning strings | Optimisation |
| 3. Priority + optimiser | 8–16 h | MILP, constraints, reconciliation ledger, unit tests | Optimisation |
| 4. API + React skeleton | 4–14 h (parallel, on mock JSON fixtures) | FastAPI routes with Pydantic schemas returning fixtures; six-stage React layout consuming them | Dashboard |
| 5. Integrate | 16–22 h | Real outputs in UI, scenario toggle, KPIs | All |
| 6. Anomaly + LLM assistant | 20–28 h | Outbreak detector, tool-calling chat, fallback | Pitch/LLM + Data |
| 7. Harden + demo | last 6 h | Full dry-runs, timing, backup recorded video, freeze code 2 h before | All |

**Interface contract (agree in Phase 0 so streams run in parallel):** forecast table `(facility, supply, date, p10, p50, p90)`; risk table `(facility, supply, days_to_stockout, lead_time, risk_level, reason)`; expiry table `(batch, unused_at_expiry, reason)`; moves table `(from, to, supply, batch, qty, eta, benefit, reason)`.

**Cut order if time runs out:** map → anomaly detector → LLM assistant → substitutes → quantile intervals. **Never cut:** correct reconciliation, lead-time-aware stock-out, expiry reasoning, outbreak before/after.

## 11. Demo script (5 min target)

1. **Hook (30 s):** the nurse and the empty vial; hospital across town with expiring stock.
2. **Normal day (45 s):** dashboard, forecasts and risk heat-map, all green/amber.
3. **Outbreak hits (60 s):** toggle outbreak; anomaly flags it; forecasts jump; Hospital A turns red "6 days to stock-out, lead time 9".
4. **System responds (90 s):** expiry list shows B wasting 490 units; optimiser proposes moves; open one move and show *why*, the ledger, arrival-before-stockout.
5. **Priority (30 s):** ranked facilities with factor bars; change a weight live.
6. **With vs without (45 s):** 6-week simulation, KPIs: stock-out days and wasted units.
7. **Assistant (30 s):** ask "Which hospitals are at highest shortage risk next week?"
8. **Close (10 s):** "Stop reacting, start anticipating."

Prepare a pre-recorded fallback video and a deterministic seed so the demo never surprises.

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Judge scenario ambiguous | Numbers "don't add up" | Ask organisers; state assumptions on-screen; editable parameters; ledger |
| Optimiser infeasible or slow | No plan shown | Start with greedy heuristic fallback; precompute scenarios; small network |
| Overfitting to synthetic data | Weak credibility | Use rolling backtest; compare vs naive; be honest on metrics |
| Scope creep (LLM, map) | Core unfinished | Strict cut order; freeze features 6 h before end |
| Live demo failure | Lose storytelling pts | Cached outputs, offline fallback for LLM, backup video |
| Judges can't trust LLM numbers | Innovation pts lost | Tool-calling only, show source table |
| Dashboard looks generic | Lower usability score | Allocate dedicated time to layout, colour semantics, single-screen flow |
| Slow compute behind API | Laggy live demo | Precompute into SQLite; GETs only read; recompute endpoint runs in background and UI shows progress |
| SQLite write contention on recompute | Errors during demo | Single writer, WAL mode, recompute writes to temp tables then swaps |
| CORS / FE-BE drift | Lost integration hours | Pydantic → OpenAPI → generated TS types; Vite proxy to backend; fixtures agreed in Phase 0 |

## 13. Success criteria

- Judge scenario runs end to end, and a judge can verify the arithmetic on screen.
- Every shortage warning has: **what, where, days left, lead time, why, action.**
- Every move has: **quantity, from, to, ETA, benefit, and constraint checks passed.**
- Measured with-vs-without improvement is the headline number in the pitch.
- Repo runs from a clean checkout with one command and fixed seed.

## 14. Open questions

1. Is there an official sample dataset/scenario file, or is the "20,000 units, 2,000 → 5,500/wk" line the full spec?
2. Required submission format (repo, video, live demo) and demo duration?
3. Team size and skills (stack is fixed: FastAPI + SQLite + React); decides whether the LLM and map stretch goals fit.
4. Allowed LLM / API access during the event?
