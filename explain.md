# MedSupply Intelligence — Technical Deep Dive

**Singularity 2026, Track 2.** "Know before the shortage."

This document is the full technical explanation of the system: architecture, data pipeline, every algorithm, every API endpoint, the database schema, and the frontend. It is written for a technical judging round — it goes past the README's "what" into the "how" and "why".

---

## 1. One-paragraph summary

A network of 8 real hospitals (Dakshina Kannada / Mangaluru region, India) shares 6 medicines. The system (1) **forecasts** daily demand per hospital × medicine 14 days out using a gradient-boosted model blended with outbreak-trend detection, (2) **projects stock** forward batch-by-batch (FEFO — first-expiry-first-out) to get exact days-to-stockout and days-to-waste, (3) **scores priority** for every hospital competing for the same scarce medicine using a transparent weighted formula, (4) **solves a mixed-integer transportation problem** (MILP, via scipy/HiGHS) to decide exactly which batch moves from which donor to which recipient, (5) **verifies** that plan against 8 hard correctness checks before showing it to a human, and (6) lets hospitals **negotiate transfers themselves** through a built-in exchange (offers/requests/messages) independent of the AI's proposals. Everything is explained in plain-language reasoning strings generated from the same numbers shown in the UI — no hidden magic numbers.

---

## 2. Architecture diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              BROWSER (React SPA)                         │
│  Dashboard · Inventory · Demand · Shortage · Expiry · Redistribution ·   │
│  Priority · Exchange · Map · Impact · Scenario · Hospitals · Assistant   │
│                                                                            │
│  App.tsx (shell/router) ── context.tsx (shared state) ── api.ts (fetch)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP / JSON  (fetch '/api/*')
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         FastAPI app  (backend/app/main.py)                │
│  CORS middleware · Pydantic request models · exception → HTTP 400        │
├──────────────────────────────────────────────────────────────────────────┤
│  engine.py  (Engine)            exchange.py (Exchange)    assistant.py   │
│  ───────────────────            ──────────────────────    ────────────── │
│  orchestrates everything         hospital-to-hospital       tool-calling │
│  below, caches by                negotiation: offers,       LLM (Gemini) │
│  (scenario, weights, version)    requests, transfers,        or rule-    │
│                                   messages, lifecycle        based router│
│       │                                                                   │
│       ├── forecast.py   → per-(hospital,medicine) 14-day demand forecast │
│       │                    (HistGradientBoostingRegressor + outbreak     │
│       │                    trend blend + backtest-derived P10/P90)       │
│       │                                                                   │
│       ├── inventory.py  → FEFO batch simulation: days-to-stockout,       │
│       │                    days-to-waste, risk level                    │
│       │                                                                   │
│       ├── priority.py   → 0–100 transparent weighted priority score      │
│       │                                                                   │
│       └── optimizer.py  → MILP (scipy.optimize.milp / HiGHS): which      │
│                             batch → which hospital, fairness tiers,      │
│                             rescue pass, emergency-loan pass             │
│                                                                           │
│  verify() in engine.py  → 8 hard correctness checks on every plan        │
└───────────────────────────────────┬──────────────────────────────────────┘
                                     │ sqlite3 (WAL mode)
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      SQLite  (backend/medsupply.db)                       │
│  hospitals · medicines · consumption (history+hidden future) · batches · │
│  lead_times · transport · transfers · offers · requests · messages ·meta │
└──────────────────────────────────────────────────────────────────────────┘
                                     ▲
                                     │ generated once, offline, deterministic
┌──────────────────────────────────────────────────────────────────────────┐
│  generate.py (synthetic data engine, seeded RNG)                         │
│  + fetch_routes.py (one-time OSRM pull of real road km/hours, cached     │
│    to data/routes.json so the app runs fully offline afterwards)         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Request flow for the main page (Dashboard → `GET /api/overview`):**

```
Browser → GET /api/overview?scenario=outbreak&w_patient_load=0.25...
   → main.py: overview()
      → engine.analysis(scenario, weights)        [cached per (scenario, weights, version)]
         → engine.forecast(scenario)               → forecast.run()        (ML forecast, cached)
         → engine.pipeline_batches()                → physical batches + in-flight transfers applied virtually
         → for every (hospital, medicine) cell:
              inventory.fefo(batches, forecast)     → stockout day, waste, unmet demand
              priority.factors() / priority.score() → 0-100 priority
         → engine._expiry()                         → waste reasoning per batch
         → engine._plan()                           → optimizer.plan() + rescue() + emergency loans
         → engine.verify()                          → 8 correctness checks against the plan
         → engine._orders()                         → supplier reorder quantities
         → engine._outcome()                        → "with system" vs "without system" simulation on hidden truth
         → engine._kpis()                           → dashboard summary numbers
      ← JSON (cells, warnings, spikes, expiry, plan, verification, orders, outcome, metrics, kpis)
   ← rendered by Dashboard.tsx / Inventory.tsx / etc.
```

Every other page/endpoint reuses the **same cached `analysis()` result** and just filters/reshapes it — there is one source of truth per (scenario, weights, data-version) tuple.

---

## 3. Tech stack

| Layer | Technology | Why |
|---|---|---|
| Backend framework | **FastAPI** (Python 3.11+) | async-ready, typed request/response via Pydantic, auto-generated OpenAPI docs at `/docs` |
| ML forecasting | **scikit-learn** `HistGradientBoostingRegressor` | handles non-linear seasonal/demand patterns, fast to train (250 iterations, <1s), native categorical support for hospital/medicine ids |
| Optimisation | **scipy.optimize.milp** (HiGHS solver) | exact mixed-integer solve for the transportation problem — not a heuristic, with a 10s time budget and greedy fallback |
| Numerics | **NumPy / pandas** | vectorised per-series forecasting and FEFO simulation across all hospital×medicine cells at once |
| Database | **SQLite** (WAL mode) | zero-ops, file-based, perfectly adequate for a single-process demo; `backend/medsupply.db` regenerated on reset |
| Frontend | **React 19 + TypeScript + Vite 8** | fast dev server, strict typing shared with backend JSON shapes (`api.ts`) |
| Styling | **Tailwind CSS 4** | utility-first, no component library lock-in |
| Charts | **Recharts** | demand forecast bands, impact comparison charts |
| Icons | **lucide-react** | |
| Routing | **hand-rolled hash router** (`router.tsx`, ~20 lines) | every sidebar page is `#/route`, works with browser back/forward, no dependency needed |
| LLM assistant (optional) | **Gemini (free tier) via function calling**, else rule-based keyword router | both paths call the *same* backend tool functions — the LLM never invents numbers, it only phrases them |

No external services are required to run the app. The only network call anywhere is the **one-time, offline-cached** OSRM road-distance fetch (`fetch_routes.py`) — the app itself runs fully offline.

---

## 4. Data layer

### 4.1 Database schema (`backend/app/db.py`)

| Table | Purpose |
|---|---|
| `hospitals` | id, name, city, lat/lon, beds, patient_load, emergency_index |
| `medicines` | id, name, unit, criticality (1–3), shelf_life_days, alternatives (JSON list), unit_cost |
| `consumption` | day index, date, hospital, medicine, `units` (outbreak scenario) / `units_base` (counterfactual), `split` (`history` or `future`) |
| `batches` | batch_id, hospital, medicine, qty, expiry_date, received_date, source |
| `lead_times` | per (hospital, medicine): supplier resupply lead time in days |
| `transport` | per (from, to): real road km and hours (OSRM) |
| `transfers` | AI-proposed or hospital-agreed moves; status lifecycle; JSON allocations (which batches, how much) |
| `offers` / `requests` | hospital-initiated surplus offers / shortage requests, broadcast or targeted |
| `messages` | every system/offer/request/chat event, threaded by transfer/offer/request id |
| `meta` | key-value run metadata (today's date, seed, outbreak start date) |

`ensure_schema()` is an additive migration (adds `target` column to `offers`/`requests` if missing) so the DB can evolve without wiping demo data outside of explicit reset.

### 4.2 Synthetic data generation (`backend/app/generate.py`)

This is the most important "trust us, the numbers are real" piece — it is **fully deterministic** (seeded NumPy RNG, `SEED=2026`) and documents exactly what's real vs simulated:

- **8 real hospitals** of Dakshina Kannada with real lat/lon (OpenStreetMap), published bed counts and OPD/day where available, with an explicit note on which figures are estimates (see `backend/DATA_SOURCES.md`).
- **6 medicines** with real NPPA ceiling prices (Apr 2025) where available, criticality tier (3=life-saving, 2=essential, 1=routine), shelf life, and substitute mappings (e.g. Ceftriaxone ↔ Amoxicillin-Clavulanate).
- **120 days of history + 14 hidden "ground truth" future days** of daily consumption per hospital × medicine, built with:
  - weekday seasonality (`DOW` multiplier array, Monday busiest)
  - hospital-size-weighted demand share
  - a **built-in flu outbreak**: starting at history day 92, Oseltamivir demand ramps via an exponential curve and is *forced* (via `force_total`) to match an exact weekly target sequence — **2,000 → 2,875 → 3,750 → 4,625 → 5,500** units/week — so the "judge scenario" numbers are byte-exact regardless of RNG noise elsewhere.
  - secondary surge multipliers on Ceftriaxone/Salbutamol/Amoxicillin (plausible secondary bacterial pneumonia / bronchospasm effect of a flu wave) at specific hospitals.
  - Poisson-gamma noise (`noisy()`) for realistic day-to-day variance without destroying the forced weekly totals.
- **Stock batches**: judge-scenario Oseltamivir batches are hand-placed per hospital to sum to **exactly 20,000 units**, deliberately unevenly distributed (some hospitals rich, some about to run out) so the redistribution engine has real work to do. Other medicines get randomised days-of-cover per hospital, with specific `COVER_OVERRIDE` values engineered to produce interesting shortage/plenty scenarios (e.g. Hospital A critical in Ceftriaxone, Hospital C comfortable).
  - "Extra batches" are seeded near-expiry (insulin at D, ORS at F) specifically to exercise the expiry/wastage detector.
- **Lead times**: base per-medicine supplier lead time (3–9 days) plus a remoteness penalty (0–2 days) derived from real road km to the district hub.
- **Transport matrix**: real OSRM driving distances/durations between every hospital pair (`fetch_routes.py`, cached to `data/routes.json` so the generator runs offline afterwards), +0.5h loading allowance per trip.

`main.py` calls `generate.generate()` automatically if `medsupply.db` doesn't exist, and `POST /api/reset` regenerates it on demand (used by the UI's "Reset demo" button).

---

## 5. The forecasting model (`backend/app/forecast.py`)

**Goal**: for every (hospital, medicine) pair, predict daily demand for the next 14 days, with an 80% confidence band, and *detect when an outbreak/spike is happening* so the forecast doesn't lag behind a fast-rising trend.

### 5.1 Core model
- One **global** `HistGradientBoostingRegressor` (not one model per series) trained across all hospital×medicine series simultaneously — this lets small series borrow statistical strength from large ones.
- **Direct multi-horizon**: a separate training example is generated for each horizon h=1..14 (not a recursive/iterative forecast), so error doesn't compound across the horizon.
- **Target normalisation**: each training target is divided by that series' own trailing 28-day mean (`rm28`), so one model can serve both a 2,000-unit/week series and a 70-unit/week series without the big series dominating the loss.
- **Features per origin day** (`origin_features`): 7/14/28-day rolling means, a pre-outbreak baseline (days 35→7 ago), 28-day CV, three ratio-to-baseline features, and a 14-day linear slope — all normalised by `rm28`. Plus horizon index, day-of-week of the *target* day, and categorical hospital/medicine index (native categorical support in HistGradientBoostingRegressor).

### 5.2 Outbreak / spike detection
- `detect()`: compares the last-7-day mean against a 35→7-days-ago baseline mean, as a z-score (z > 3.0) *and* a ratio (>1.25×) — both conditions must fire, so normal weekly variance doesn't trip it.
- When a series is flagged, the forecast is **blended**: 70% a damped log-linear trend fitted to the last 14 days of deseasonalised demand (`trend_forecast`, growth rate clipped to [-5%, +8%]/day, damping factor 0.85/day so the extrapolation doesn't explode) + 30% the tree model's own (lagging) prediction. Trees cannot extrapolate past demand levels they've seen in training, so pure-GBM forecasts under-react to a genuinely new outbreak; the trend blend fixes that while GBM still anchors seasonality/weekday effects.
- `detected_day`: walks backward through a rolling re-detection to find the *first* day the current, still-active spike was flagged — shown in the UI as "Spike detected on 13 Sep."
- **Daily anomaly markers**: any single day whose trailing-28-day z-score exceeds 3 is flagged as an anomaly dot on the demand chart (separate from the sustained-spike detector).

### 5.3 Uncertainty bands (P10/P90)
- A **backtest** (`backtest()`) holds out the last 14 days, trains fresh, and measures relative residuals `(actual - predicted)/predicted`, separately for spike-flagged vs normal series and per medicine.
- Those residual standard deviations become per-medicine (or per-spike) sigma values, clipped to [0.05, 0.6] normal / [0.1, 0.8] spike-flagged, converted to an 80% interval via the z-score for the 80th percentile (1.2816): `p10 = p50*(1-1.2816·σ)`, `p90 = p50*(1+1.2816·σ)`.
- The same backtest also reports MAE/MAPE/WAPE against a **seasonal-naive baseline** (same weekday last week), proving the model's lift — in the current seeded run: ~26% WAPE (naive) → ~5% WAPE (outbreak-adjusted model) on the Oseltamivir network aggregate.

### 5.4 Long-horizon projection for expiry
- Forecasts only run 14 days explicitly, but expiry projections need to look out hundreds of days (`LONG_HORIZON=800`). The `ext` array extends the forecast by **decaying any detected spike back to its own pre-spike baseline** on a 14-day half-life, re-applying weekday seasonality — so a batch expiring in 300 days is tested against a demand path that assumes the outbreak eventually subsides, not permanently elevated demand.

---

## 6. Stock projection — FEFO simulation (`backend/app/inventory.py`)

Given a list of batches (id, qty, days-until-expiry, arrival day, virtual flag) and a demand path, `fefo()` simulates day by day:

1. Batches not yet arrived wait in a `pending` queue, sorted by arrival day, and are added to the "live" pool once their arrival day passes.
2. Any batch whose expiry has passed is marked **wasted** (its entire remaining quantity) and removed.
3. Demand for the day is drawn from the **earliest-expiring** live batch first (First-Expiry-First-Out) — this is the same policy a real pharmacy stock room should follow, and it's what makes the expiry/waste numbers meaningful (a batch isn't "wasted" just because it exists; it's wasted only if FEFO literally never gets to it before it expires).
4. Unmet demand (demand that no batch could cover) accumulates per day; the first day this happens gives a **fractional days-to-stockout** (`k + avail/need`), e.g. 4.7 days.
5. After day 30, if both the live pool and the pending queue are empty, the simulation short-circuits — all remaining demand is unmet (keeps numbers correct on long horizons without wastefully simulating 800 days by hand each time... except — ext *is* 800 days long for exactly the expiry check, so this early-exit only fires once a series is fully dry).

**Risk level** (`risk_level`) is a deterministic function of days-to-stockout vs supplier lead time:
- `stockout` — already out (dts < 0.5 day)
- `critical` — runs out *before* an order placed today would arrive (dts < lead_days)
- `high` — runs out within lead_days + 3-day safety buffer
- `watch` — runs out within lead_days + 7 days
- `ok` — otherwise

This is the single rule that drives every red/orange/yellow/green indicator across the whole UI.

`warning_text()` turns that into the exact plain-English sentences shown in the Shortage Risk page ("City General Hospital runs out of Oseltamivir in 5 days (lead time 9 days): an order placed today arrives too late. Transfer stock now and order 1,250 capsules.") — every number in that sentence is read straight out of the simulation, nothing is templated separately from the math.

---

## 7. Priority scoring (`backend/app/priority.py`)

When multiple hospitals compete for the same scarce medicine, who should get it first? This is computed as a transparent **weighted linear score**, not a black box:

```
score = 100 × Σ(weight_f × factor_f) / Σ(weight_f)      — one factor per criterion, each in [0,1]
```

| Factor | Formula | Meaning |
|---|---|---|
| `patient_load` | `patients_per_day / max_hospital_load` | bigger hospitals get proportionally more weight |
| `emergency` | `0.5·emergency_index + 0.5·clip(surge-1, 0, 1)` | half fixed ER/ICU intensity, half this medicine's *current* demand surge |
| `criticality` | `medicine_tier / 3` | life-saving medicines (tier 3) weigh more than routine ones (tier 1) |
| `no_alternative` | `1` if no substitute exists, else `1 - clip(alt_spare_days/14, 0, 1)` | a hospital sitting on a usable substitute (e.g. Amoxicillin instead of Ceftriaxone) needs less urgent help |
| `urgency` | `1 - clip(dts/(lead+safety+7), 0, 1)` | closer to stockout relative to lead time = more urgent |

Default weights (`DEFAULT_WEIGHTS` in config.py) are 0.25/0.25/0.15/0.15/0.20 but are **fully adjustable live in the Prioritisation UI page** via sliders — changing them re-scores every hospital *and* re-runs the optimiser (since the optimiser's objective uses `1 + score/100` as a per-hospital weight), so judges can see the redistribution plan itself shift in response to policy choices.

`explain()` generates the same kind of grounded natural-language sentence as the warnings ("City General Hospital: high patient load (1,050/day); demand up 45% vs baseline; runs out in 4 days vs 6-day lead time. Biggest factor: urgency.").

---

## 8. The redistribution optimizer (`backend/app/optimizer.py`)

This is a genuine **mixed-integer linear program**, solved exactly (not heuristically) with scipy's HiGHS backend, per medicine, per re-plan.

### 8.1 Decision variables
For every (donor batch, recipient) route that passes basic feasibility (batch arrives with ≥2 usable days before its own expiry, recipient actually has unmet demand in that window):
- `x[route]` — continuous units shipped (bounded by `cap` = min(batch qty, recipient need, donor surplus, recipient's demand-absorption capacity before that batch's expiry))
- `y[route]` — binary "this route is used at all" (enables the fixed per-move penalty and a minimum-lot-size constraint via `x ≤ cap·y` and `x ≥ MIN_LOT·y`)
- `z[donor,batch]` — continuous "units of this otherwise-wasted batch rescued" (bounded by that batch's own projected waste)
- `u[recipient,tier]` — continuous "units of recipient's need filled in this fairness tier"

### 8.2 Constraints
- Recipient receives at most its projected need (unmet demand before supplier resupply can physically arrive).
- Donor batch gives at most its quantity; donor hospital gives at most its *surplus* (stock above its own P90 demand over `max(horizon, lead_time+safety)` — i.e. a donor never gives away stock it will itself need).
- Shipped quantity is capped by how much demand the recipient can actually consume between arrival and that batch's expiry — **never ship stock that will expire in transit or just after arrival**.
- Minimum lot size (10 units) — no trivial/noise moves.
- Fairness: need is split into **tiers** — first 25%, next 25%, final 50% — each tier carrying a bonus strictly larger than any possible priority-score gap. This guarantees every hospital's first quarter of need is filled network-wide before *any* hospital gets its remainder; priority only decides ordering *within* a tier, so one high-priority hospital can never fully starve a low-priority one while sitting on comfortable stock itself.

### 8.3 Objective
Maximise `Σ priority-weighted tier bonuses + waste-rescue bonus − transport-hour cost − per-move fixed penalty`, with a small tie-break favouring shipping earlier-expiring stock first.

### 8.4 Three solver passes (per medicine)
1. **`plan()`** — the MILP above: who needs what, matched against who has free (already-on-hand) surplus.
2. **`rescue()`** — a second, simpler greedy pass: for stock a donor would waste regardless (no one "needs" it under tier-1 rules), route it to whichever hospital will run short of it before that expiry date anyway, capped by that hospital's own projected unmet demand in the window — this literally cannot create new waste anywhere, it only relocates demand that would otherwise be met by a fresh supplier order.
3. **`_emergency_loans()`** (in `engine.py`, calls `optimizer.plan()` again with looser donor constraints) — runs only on whatever residual need the first two passes couldn't cover. Here a donor only has to keep its own **lead-time + safety-buffer** stock (not a full 14-day P90 reserve) since it will simply reorder to replace the loan — this is what lets hospitals with long cover lend into genuinely desperate situations ("emergency loan", shown orange in the UI) while the system still proves the donor itself stays covered until its own resupply arrives.

If the MILP solver fails to return a solution within its 10-second budget, `greedy()` is a deterministic fallback (highest-priority recipient first, nearest donor, earliest-expiring batch) — the system never silently returns nothing.

Every move is annotated with a plain-English `reason` string built from the same numbers (km, hours, days-to-stockout, what the donor keeps and why), and a stable `key` (`medicine:from>to:kind`) so hospitals can select/deselect specific transfers to actually send without the UI losing track across re-plans.

---

## 9. Plan verification (`engine.verify()`)

Before any plan is shown as trustworthy, it is checked against **8 hard, automatically-computed correctness checks** (also unit-tested, see `test_system.py`):

1. **Network units conserved** — total stock of each medicine before = after, summed across all hospitals.
2. **No batch over-drawn** — no donor batch's quantity goes negative.
3. **No stock shipped that expires before it can be used** — every shipped allocation keeps ≥2 usable days after arrival.
4. **Shortage transfers never exceed the recipient's need** — a hospital is never sent more "need"-type stock than its own projected unmet demand.
5. **Every transfer arrives before the recipient runs out** — arrival day ≤ floor(days-to-stockout).
6. **Donors stay covered** — simulating the plan applied, no donor hospital's own unmet-demand window gets *worse* than before donating (14-day window normally; until the donor's own resupply arrives for emergency lenders).
7. **No transfer creates new waste at the recipient** — a hospital that receives stock doesn't end up wasting more than it would have wasted anyway.
8. **Ledger balances per hospital** — `before − out + in = after`, row by row.

This is implemented by literally re-simulating the network **with the plan applied** (`apply_moves`) and comparing FEFO outcomes before/after for every touched (hospital, medicine) pair — it is not a set of assertions on the optimizer's own internal state, it is an independent re-derivation from the same primitives (`fefo`, demand forecasts) used everywhere else. `GET /api/overview` (and every page built on it) exposes `verification.passed` and the per-check detail strings; the sidebar shows a persistent "✓ Plan verified" / "✗ Plan not verified" badge.

---

## 10. With-system vs without-system impact simulation (`engine._outcome()`)

The 14 **hidden future days** of ground-truth demand generated by `generate.py` (never seen by the forecaster) are used to run two parallel simulations:

- **"Without"**: no transfers at all; a hospital reacts only once it's already out of stock, ordering from its supplier that day (arrives after the full lead time).
- **"With"**: the actual computed transfer plan is applied, plus proactive supplier orders placed *today* for any high/critical-risk cell.

Both are run against the **same real hidden demand**, and the difference (stockout-cells, stockout-days, unmet units, unmet units of critical medicines specifically, wasted units) is the system's honestly-measured impact — not a simulated-against-itself number. Current seeded run: 5,679 unmet doses without the system vs 1,196 with it; wasted units on affected hospitals fall from 1,474 to 211.

---

## 11. The judge/sample scenario (`engine.judge()`)

A dedicated endpoint (`GET /api/judge`) packages the specific scenario the hackathon brief describes — 20,000 units of Oseltamivir, weekly demand rising 2,000→5,500 — into one response: current stock, the exact weekly demand series, aggregate network days-of-cover, the forecast with its P10/P90 band, per-hospital detail, the actual transfer plan, its full verification ledger, and a generated natural-language statement tying all of those numbers together. This exists so the numbers the brief cites can be checked in one API call, and is also exposed as its own "Scenario test" UI page.

---

## 12. API surface (`backend/app/main.py`)

| Method & path | Purpose |
|---|---|
| `GET /api/meta` | hospitals, medicines, default weights, transport matrix, today's date |
| `GET /api/overview?scenario=&w_*=` | the full analysis (cells, warnings, spikes, expiry, plan, verification, orders, outcome, metrics, kpis) — the one big payload the Dashboard and most pages build on |
| `GET /api/forecast?scenario=&medicine=&hospital=` | per-series history + 14-day forecast + weekly aggregates, for the Demand page's chart |
| `GET /api/hospital/{id}?scenario=` | everything scoped to one hospital, plus its exchange board |
| `GET /api/judge?scenario=` | the sample-scenario packaged response |
| `GET /api/compare` | outcome + KPIs for both scenarios side by side (Impact page) |
| `POST /api/exchange/send-plan` | opens real `transfers` for some/all of the AI's proposed moves (selective send, matched by stable `key` or id) |
| `POST /api/transfers/{id}/action` | approve / decline / dispatch / receive / cancel — enforces who may act and when |
| `POST /api/offers`, `POST /api/offers/{id}/claim`, `/decline`, `/withdraw` | hospital-initiated surplus offers, broadcast or targeted, and their lifecycle |
| `POST /api/requests`, `/respond`, `/decline`, `/withdraw` | hospital-initiated shortage requests, mirrored lifecycle |
| `POST /api/messages` | free-text chat tied to a transfer thread |
| `GET /api/exchange?hospital=` | the exchange board (transfers/offers/requests/messages) for one hospital or the whole network |
| `POST /api/assistant` | natural-language question → grounded answer |
| `POST /api/reset` | regenerates the database and clears all exchange activity — the one-click "clean demo state" button |

All error cases (invalid scenario, unknown hospital/medicine, wrong actor trying to approve someone else's transfer, zero/negative quantities, self-addressed offers, over-claiming) raise `ExchangeError` → translated to **HTTP 400** with a human-readable `detail`, which the frontend surfaces as a red toast.

In production/demo mode, the same FastAPI process also serves the built React app (`frontend/dist`) directly — `/` and any unknown path fall through to `index.html` (SPA routing), `/assets/*` is a static mount. This is why the whole app is one process in the one-process run mode: no CORS, no separate static server needed.

---

## 13. Hospital exchange (`backend/app/exchange.py`)

Separate from (but feeding into) the AI's optimiser, hospitals can coordinate directly:

- **Offer**: a hospital with surplus posts an offer, either to one named hospital or broadcast to all. If broadcast, the system immediately computes `suggest_takers()` — which other hospitals have projected unmet demand *before that batch's own expiry* — and notifies them directly, on top of the public broadcast message.
- **Request**: mirror image — `suggest_donors()` finds hospitals sitting on surplus above their own 14-day P90 reserve.
- **Accept/claim** on either immediately creates an already-**approved** transfer (both sides have agreed, so no separate approval step is needed) — the donor just needs to dispatch it.
- **AI-proposed transfers** (from `send_plan()`) instead start **pending**, awaiting the donor's explicit approval — the network AI can propose, but per the project's design rule it can never itself approve/decline/dispatch/receive/cancel; only hospital nodes act on transfers. This is enforced server-side (`actor not in self.e.H` → `ExchangeError`), not just hidden in the UI.
- **Transfer lifecycle**: `pending → approved → in_transit → delivered` (or `declined`/`cancelled` at the earlier stages). Only `receive` (confirm receipt) actually mutates `batches` in the database — donor physical stock only drops, and recipient stock only rises, at that final step; everywhere else in the UI the pending quantity shows as `+incoming` / `−committed` so numbers are never double-counted.
- Every transition posts a **system message** threaded to that transfer/offer/request id, which is what populates the Inbox / chat view per hospital.
- `allocate()` is the shared batch-picking logic used both by manual offers/claims and (via `optimizer`) the AI plan: always picks free (not already committed to another active transfer), earliest-expiring stock first, and rejects the whole operation if there isn't actually enough free stock — so a hospital can never accidentally offer more than it truly has spare.

---

## 14. The assistant (`backend/app/assistant.py`)

Two interchangeable backends behind one `ask()` call, **both grounded in the same tool functions** — the LLM path is never allowed to invent a number:

- **Tool layer** (`tools()`): 8 Python functions — `shortage_risks`, `expiry_risks`, `redistribution_plan`, `priority_ranking`, `hospital_summary`, `outbreak_signals`, `demand_forecast`, `judge_scenario` — each a thin, formatted wrapper around `engine.analysis()` / `engine.series()` / `engine.judge()`.
- **Gemini path** (if `GEMINI_API_KEY` + `GEMINI_MODEL` are set in `.env`): sends the question with function-calling declarations for all 8 tools to Gemini, executes whichever tools it calls, feeds results back, loops up to 5 rounds, and returns Gemini's final phrased answer. A strict system prompt forbids inventing numbers, requires exact risk-label wording, and caps response length.
- **Rule-based fallback** (always available, zero dependencies): keyword-matches the question (medicine aliases like "tamiflu"→OSEL, hospital name/city/nickname matching, day-count extraction) to pick a tool and fill a template — used automatically if no API key is set, or if Gemini's call fails for any reason (the failure reason is reported back in a `note` field, never silently swallowed).
- Either way the response includes a `tools` array recording exactly which backend functions were called with which arguments and results — shown in the UI so a judge can audit that the answer traces back to real computed data, not a hallucination.

---

## 15. Frontend architecture

- **`main.tsx`** — React root.
- **`App.tsx`** — the shell: sidebar navigation (grouped into Overview / Predict / Act / Analyse / Assist), header (scenario toggle outbreak/no-outbreak, "Acting as" hospital selector, Reset demo button), toast notifications, and the single `useApi` call to `GET /api/overview` that most pages consume via context.
- **`router.tsx`** — a ~20-line hash router (`#/path`); every sidebar item is its own URL, back/forward works, no routing library needed for an app this size.
- **`context.tsx`** — one `AppState` (meta, overview data, current scenario/weights/actor/med/hosp selection, an `act()` helper that wraps any mutating API call with toast success/error + triggers a re-fetch) shared via React context so pages don't prop-drill.
- **`api.ts`** — the single typed boundary to the backend: every backend JSON shape has a matching TypeScript interface (`Cell`, `Move`, `ExpiryRow`, `Verification`, `Outcome`, `Board`, `Judge`, etc.), plus `get`/`post` fetch wrappers and a `useApi` hook (cancels stale responses via a sequence ref, so a fast scenario toggle can't show an old response arriving late).
- **`pages/*.tsx`** — one file per sidebar item (Dashboard, Inventory, Demand, Shortage, Expiry, Redistribution, Priority, Exchange, MapView, Impact, Scenario, Hospitals, Medicines, Assistant) — each reads `useApp()` and renders its slice of the shared overview payload, or makes its own narrower `useApi` call (e.g. Demand's per-series forecast, Hospitals' per-hospital drill-down).
- **`components/ui.tsx`** / **`components/charts.tsx`** — shared primitives (buttons, selects, badges, loading skeletons) and chart wrappers (Recharts) reused across pages for visual consistency.
- Badges in the sidebar (shortage count, expiry count, pending moves count) are computed live from the same overview payload — no separate badge-count endpoint.

**Build modes**: dev (`npm run dev`, Vite dev server on :5173 proxying `/api` to the backend on :8000) or production (`npm run build` → `frontend/dist`, served directly by FastAPI as one process — the mode used for the actual demo).

---

## 16. Testing

20 automated backend tests (`pytest`, ~6s, isolated temp database — never touches the real demo DB):

- Judge scenario numbers are exact (20,000 units; weekly series exactly as specified; conservation).
- All 8 verification checks pass, for both scenarios.
- Forecast model beats seasonal-naive; outbreak is detected only in the outbreak scenario (not the counterfactual).
- Impact simulation shows the system genuinely reduces unmet demand and waste.
- Full transfer lifecycle (pending→approved→in_transit→delivered), including rejecting the wrong actor at each step.
- Offer/claim and request/respond flows, both broadcast and targeted, including self-accept rejection and declining/withdrawing.
- The network admin is provably read-only (cannot approve/decline/dispatch/receive/cancel anything — asserted via HTTP 400).
- Selective send: sending one chosen move creates exactly one transfer; sending nothing is rejected.
- Emergency loans: even with zero spare stock under normal rules, the engine still finds loans, every check still passes, and each loan states what the donor keeps and why.

Frontend: `npm run typecheck` (strict TS across the whole shared type surface) + `npm run build`.

---

## 17. What's real vs simulated (for honesty with judges)

- **Real**: hospital names/locations/bed counts (OpenStreetMap + public sources), road distances/times (OSRM), medicine identities and several NPPA ceiling prices, criticality/shelf-life/substitute clinical facts.
- **Estimated**: a few bed counts and the emergency-intensity index (no public source; documented as assumptions in `backend/DATA_SOURCES.md`).
- **Simulated (by design, for a reproducible demo)**: all daily consumption, current stock levels, the outbreak itself, and the 14 hidden ground-truth days used for impact measurement — seeded (`SEED=2026`) so every run produces the same numbers, and the judge-scenario stock/demand totals are deliberately forced to match the brief exactly.

This separation is intentional: the **engineering** (forecasting method, FEFO stock logic, MILP optimisation, verification, negotiation protocol) is the submission; the data is a realistic, labelled stand-in for what would be a live hospital inventory feed in production.
