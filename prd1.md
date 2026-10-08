# Product Requirements Document: MedSupply Intelligence

| | |
|---|---|
| **Product** | MedSupply Intelligence, a medical supply early-warning and redistribution platform |
| **Tagline** | "Know before the shortage." |
| **Status** | Working MVP (backend, optimiser, exchange, dashboard, assistant) |
| **Repository** | `medsupply-intelligence` (FastAPI backend, React frontend) |
| **Document version** | 1.0 |

---

## 1. Overview

MedSupply Intelligence helps a hospital network administrator and individual hospital pharmacists answer four questions about medicine supply: **what is needed, where, when it runs out, and how limited stock should be shared.**

The platform forecasts medicine demand for every hospital and medicine, predicts stock-outs against supplier lead times, detects stock that will expire unused, and computes verified stock transfers between hospitals. Hospitals coordinate those transfers (and ad-hoc offers and requests) through a built-in exchange. A tool-calling assistant answers plain-language questions from the same computed data.

## 2. Problem statement

- Hospitals typically discover shortages after the shelf is empty. Resupply takes days, so by then the shortage is already clinical harm.
- Meanwhile other hospitals hold the same medicine in surplus and it expires unused. Network-level stock is often adequate; its placement is not.
- Demand can change sharply and without warning (for example a seasonal influenza outbreak driving Oseltamivir and antibiotic use).
- Redistribution today is ad hoc: phone calls, no shared view of who has what, and no guarantee that a shipped batch will still be usable on arrival.

## 3. Goals and non-goals

### Goals
1. Predict demand per hospital and per medicine, with prediction intervals, and react to outbreaks early.
2. Warn of stock-outs in terms an administrator can act on: *which hospital, which medicine, how many days left, how long resupply takes, what to do*.
3. Detect expiry and wastage risk per batch, with the reasoning shown.
4. Recommend concrete transfers ("Move 1,258 capsules of Oseltamivir from B to A, 6.1 km, about 0.6 h") that provably satisfy constraints (conservation of units, shelf life, arrival before stock-out, donor safety).
5. Prioritise scarce critical medicines transparently and let the administrator change the priorities.
6. Let hospitals act on recommendations and trade among themselves, with an audit trail.
7. Prove the effect by comparing a system-assisted run to a no-system run on held-out demand.

### Non-goals (current version)
- Integration with real hospital information systems or pharmacy ERPs.
- Authentication, role enforcement and multi-tenancy (the UI uses an "Acting as" selector).
- Procurement and purchase-order execution (the system recommends order quantities only).
- Regulatory compliance workflows (cold-chain audit, controlled-substance tracking).
- Mobile application.

## 4. Users and personas

| Persona | Needs | Primary surfaces |
|---|---|---|
| **Network supply administrator** | Network-wide view; which hospitals are at risk; approve a plan; see impact | Overview KPIs, risk heat-map, redistribution plan, priority, impact, assistant |
| **Hospital pharmacist** | Own stock and risk; offer surplus; request stock; approve, dispatch and receive transfers | Inventory, Exchange board (as that hospital), messages |
| **Reviewer / auditor** | Verify the numbers add up | Verification checks, per-hospital ledger, reference-scenario panel |

## 5. Scope

### 5.1 In scope (implemented)
- 8 hospitals, 6 medicines, 120 days of daily consumption history plus 14 days of held-out "true" demand.
- Per-(hospital, medicine) forecast, 1 to 14 day horizon, with P10 and P90.
- Outbreak (spike) detection and outbreak-adjusted forecasting.
- FEFO batch simulation, days-to-stock-out, lead-time-aware risk levels.
- Expiry and wastage detection per batch.
- MILP redistribution optimiser plus a rescue pass for would-be-wasted stock.
- Eight-point plan verification and per-hospital ledger.
- Weighted, adjustable priority scoring.
- Hospital exchange: surplus offers, stock requests, transfer lifecycle, message threads.
- With-system versus without-system impact simulation, for both outbreak and no-outbreak scenarios.
- Assistant with eight backend tools, optional Gemini function calling, rule-based fallback.
- Single-page dashboard served by the backend.

### 5.2 Future work
See section 14.

## 6. Reference data and scenarios

### 6.1 Network
Eight real hospitals of Dakshina Kannada (Mangaluru region), identified A to H:

| ID | Hospital | City | Beds | Role in the network |
|---|---|---|---|---|
| A | Government Wenlock District Hospital | Mangaluru | 1,000 | Largest public referral hospital; high emergency load |
| B | A.J. Hospital & Research Centre | Mangaluru | 512 | Private tertiary; typical surplus donor |
| C | Father Muller Medical College Hospital | Mangaluru | 1,250 | Teaching hospital; antibiotic surge |
| D | CHC Moodbidri | Moodbidri | 30 | Small community health centre |
| E | Government Lady Goschen Hospital | Mangaluru | 290 | Women's and children's; high emergency index |
| F | Puttur Government Taluk Hospital | Puttur | 100 | Rural taluk hospital |
| G | Belthangady Taluk Hospital | Belthangady | 100 | Rural taluk hospital |
| H | KVG Medical College Hospital | Sullia | 682 | Remote medical college |

Coordinates come from OpenStreetMap and road distances and drive times from OSRM (`backend/app/data/routes.json`). Bed counts, outpatient loads and prices are sourced where public figures exist and flagged as estimates where they do not. **Per-hospital medicine consumption, stock and the outbreak are simulated**, because no hospital publishes them. Every field is classified real, estimated or simulated in [`backend/DATA_SOURCES.md`](backend/DATA_SOURCES.md).

### 6.2 Medicines

| ID | Medicine | Unit | Criticality | Notes |
|---|---|---|---|---|
| OSEL | Oseltamivir 75 mg | capsules | 3 (life-saving) | Outbreak driver; no alternative |
| CEFT | Ceftriaxone 1 g inj. | vials | 3 | Alternative: AMOX |
| AMOX | Amoxicillin-Clavulanate 625 mg | tablets | 2 (essential) | Alternative: CEFT |
| INSU | Insulin Glargine 100 IU/ml | pens | 3 | Cold chain; no alternative |
| SALB | Salbutamol nebules 2.5 mg | nebules | 2 | Wheeze and bronchospasm surge |
| ORS | ORS sachets | sachets | 1 (routine) | |

### 6.3 Scenarios
- **Outbreak (current):** an influenza outbreak begins on history day 92. Oseltamivir demand ramps; Ceftriaxone, Salbutamol and Amoxicillin demand rise in selected hospitals.
- **No outbreak (counterfactual):** the same network with no surge, used to show what the outbreak changed.
- **Reference scenario** (`GET /api/judge`): Oseltamivir network stock is exactly **20,000 units**, unevenly placed, and network weekly demand is exactly **2,000, 2,875, 3,750, 4,625, 5,500** over the last five weeks. It is a fixed, auditable worked example for the optimiser and ledger.

All generation is seeded (`SEED = 2026`) so a clean checkout reproduces identical data.

## 7. Functional requirements

### FR1. Demand forecasting
- One global gradient-boosting model (scikit-learn `HistGradientBoostingRegressor`) across all hospital-medicine series, direct multi-horizon (1 to 14 days), with target normalised by each series' 28-day mean so large and small series share one model.
- Features include lags, rolling statistics, day of week and series descriptors. Forecasts for day *t* use only data up to *t-1*; evaluation is a rolling-origin backtest on the last 14 days, never a random split.
- Prediction intervals (P10, P90) derived from backtest residual spread.
- Backtest metrics MAE, MAPE and WAPE reported against a seasonal-naive baseline, and against the outbreak-adjusted model.

### FR2. Outbreak and anomaly detection
- Spike detector using a z-score plus a ratio against a 28-day baseline, applied per series.
- Flagged series blend in a damped log-linear trend so the forecast follows the surge instead of lagging it. The long-range projection lets the spike decay back to baseline with a 14-day half-life.
- Spike signals are exposed per hospital and medicine (dates, magnitude) and feed the dashboard and assistant.

### FR3. Shortage risk
- Run a first-expiry-first-out (FEFO) simulation of each hospital's batches against forecast demand (median and pessimistic P90) to obtain **days to stock-out**.
- Compare against supplier lead time plus a safety buffer (`SAFETY_DAYS = 3`). Risk levels:
  - **critical**: stock-out before lead time (an order placed today arrives too late);
  - **high / order now**: stock-out within lead time plus buffer;
  - **watch** and **ok**.
- Every warning states what, where, days left, lead time and the action, for example: "...runs out of Oseltamivir 75 mg in 5 days (lead time 9 days): an order placed today arrives too late...".
- Recommended supplier order quantity per cell, listed as orders to place today.

### FR4. Expiry and wastage detection
- Per batch: quantity minus the demand drawable before expiry, minus what earlier-expiring batches already cover, gives projected waste in units and in rupees.
- Reasoning shown in one line (stock versus demand before the expiry date).
- Wastage candidates feed the optimiser as donor stock and can be broadcast as a surplus offer.

### FR5. Redistribution optimiser
Per medicine, a mixed-integer linear program (scipy HiGHS) that decides units moved from donor batches to recipients.

- **Hard constraints:** recipient moved quantity does not exceed its need before resupply; donor keeps its own protected demand (its 14-day P90 demand); batch quantities are respected; no shipping stock that expires in transit or before the recipient can use it; minimum lot size.
- **Fair share:** tiered allocation, so every hospital's first 25% of need is filled before anyone's remainder.
- **Objective:** priority-weighted unmet demand, with a small penalty per move and per hour of transport.
- **Rescue pass:** a second pass sends otherwise-wasted stock to hospitals that would run out before it expires.
- **Output per move:** medicine, donor, recipient, quantity, distance (km), transport time (hours), source batches, benefit and a plain-language reason ("why").
- Residual need not coverable by transfers is reported ("Still short") with supplier order recommendations.

### FR6. Plan verification
Eight automated checks run on every plan and are shown in the UI:
1. Network units conserved (units in equal units out).
2. No batch over-drawn.
3. No stock expires in transit or on arrival.
4. Shortage transfers do not exceed recipient need.
5. Every transfer arrives before the recipient runs out.
6. Donors stay covered for their own demand.
7. No new waste is created at recipients.
8. Per-hospital ledger balances: before minus out plus in equals after.

### FR7. Critical-supply prioritisation
- Score from 0 to 100 from five factors: patient load, emergency demand, medicine criticality, no alternative on hand, urgency. Default weights: patient load 0.25, emergency 0.25, criticality 0.15, no alternative 0.15, urgency 0.20.
- Administrator adjusts weights with sliders; the ranking, per-factor contribution and an explanation update, and the same weights drive the optimiser so ranking and plan stay consistent.
- Alternative availability matters: a hospital holding a substitute ranks lower than demand alone suggests.

### FR8. Hospital exchange
- **Plan dispatch:** administrator sends the optimiser's moves to hospitals as pending transfers.
- **Transfer lifecycle:** pending, approved (donor), in transit (donor dispatches), delivered (recipient receives). Only the correct party can take each step (otherwise HTTP 400). Delivery moves batches in the database, so stock levels change and the network total is unchanged.
- **Surplus offers:** a hospital broadcasts a surplus batch; the system matches takers who can use it before expiry; takers claim a quantity, which creates a pending transfer.
- **Stock requests:** a hospital requests a quantity; the system suggests donors by surplus and distance; a donor responds, creating a transfer awaiting the requester.
- **Messages:** per-transfer threads and a notification board per hospital.
- Delivered moves are not re-proposed by later planning runs.

### FR9. Impact simulation
- 14-day simulation on the held-out true demand.
- **Without the system:** no transfers; hospitals reorder only after running out.
- **With the system:** transfers plus proactive orders.
- Reported for both scenarios: stock-out days, unmet doses and wasted units.

### FR10. Assistant
- Eight tools over the computed analysis: `shortage_risks`, `expiry_risks`, `redistribution_plan`, `priority_ranking`, `hospital_summary`, `outbreak_signals`, `demand_forecast`, `judge_scenario`.
- **Rules mode (default, no key needed):** routes the question to tools and fills answer templates. The answer footer shows `mode: rules` and the tools used.
- **Gemini mode (optional):** with `GEMINI_API_KEY` and `GEMINI_MODEL` set in `backend/.env`, the model selects tools via function calling and writes the answer from tool output. Falls back to rules mode, and says so, if the call fails. This path is implemented but has not been tested against the live API.
- The assistant never produces numbers of its own; it cites tool results.

### FR11. Dashboard
Single-page flow, top to bottom:
1. **KPI strip:** hospitals at risk, outbreak signals, plan verification status.
2. **Inventory:** hospital by medicine grid with stock, cover and risk colour; click a cell to focus the forecast; click a hospital for the drill-down drawer.
3. **Predicted demand:** actuals, forecast, 80% band, anomaly markers, spike line, backtest table; per hospital or whole network.
4. **Shortage risk:** warning sentences and supplier orders to place today.
5. **Expiry risk:** at-risk batches with reasoning and a "Broadcast surplus offer" action.
6. **Redistribution:** network map with transfer arrows, move cards with reasons, verification list, ledger, network totals, "Still short".
7. **Exchange:** offers, requests, transfers, message threads, with an "Acting as" selector for network admin or any hospital.
8. **Priority:** ranked facilities, factor contributions, adjustable weights with "Apply & re-plan".
9. **Impact:** with versus without system, Before/After outbreak toggle.
10. **Reference scenario panel:** 20,000-unit worked example with per-hospital before and after.
11. **Assistant:** chat with sample questions and tool citations.
12. Header controls: scenario toggle (outbreak or no-outbreak), **Reset demo**.

### FR12. Data lifecycle
- The SQLite database is created automatically on first start from the seeded generator.
- **Reset demo** (`POST /api/reset`) regenerates the database and clears transfers, offers, requests and messages.

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| **Determinism** | Fixed seed; identical data and results from a clean checkout |
| **Performance** | Analysis for 48 hospital-medicine cells, forecast and MILPs, served interactively; automated suite runs in about 6 seconds |
| **Correctness** | Every plan passes the eight verification checks; network units are conserved |
| **Explainability** | Every warning and move carries a plain-language reason |
| **Reliability** | Assistant degrades to rules mode if the LLM is absent or fails; the UI reports when the backend is unreachable |
| **Portability** | One backend process serves UI and API; runs on Windows with Python 3.11+ and Node 20.19+ or 22.12+ |
| **Security (current)** | No authentication; CORS open for development; secrets only in git-ignored `.env`; see section 13 for the production gap |
| **Testability** | Automated backend tests use an isolated temp database and never touch `medsupply.db` |

## 9. System architecture

```
 seeded generator ──▶ SQLite (medsupply.db)
 (generate.py)                │
                              ▼
   ┌──────────────── Engine (engine.py) ────────────────┐
   │ forecast.py   inventory.py     priority.py          │
   │ (HistGB,      (FEFO, days to   (weighted score)     │
   │  spikes)       stock-out,                           │
   │                expiry)                              │
   │            optimizer.py (MILP + rescue pass)        │
   │            verify + ledger + impact simulation      │
   └───────────┬───────────────────────────┬─────────────┘
               ▼                           ▼
        exchange.py                  assistant.py
  (offers, requests, transfers,   (8 tools; rules or Gemini)
   messages; writes to DB)
               └──────────────┬────────────┘
                              ▼
                   FastAPI (main.py, REST/JSON)
                              ▼
            React single-page dashboard (served from frontend/dist)
```

- The analysis is computed in-process by `Engine`, cached per scenario and weight set, and recomputed after changes that affect stock (for example a delivered transfer).
- The frontend is a thin consumer: all figures, reasons and verification results come from the API, so the UI cannot drift from the engine.

## 10. Technology stack

| Layer | Technology |
|---|---|
| Backend language and framework | Python 3.11+ (tested on 3.14), FastAPI, Uvicorn, Pydantic |
| Data and ML | pandas, NumPy, scikit-learn (HistGradientBoostingRegressor) |
| Optimisation | SciPy (HiGHS MILP solver) |
| Database | SQLite (single file, WAL mode, foreign keys on) |
| Assistant | Rule-based tool router; optional Google Gemini function calling over the same tools |
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4, Recharts 3, lucide-react icons |
| Geo data | OpenStreetMap (coordinates), OSRM (road distance and drive time) |
| Testing | pytest with FastAPI TestClient (httpx); TypeScript type-check |

Dependencies are pinned loosely in `backend/requirements.txt` and `frontend/package.json`.

## 11. Data model

SQLite tables (`backend/app/db.py`):

| Table | Purpose | Key fields |
|---|---|---|
| `meta` | Run metadata | today, history/future days, outbreak start, seed |
| `hospitals` | Network | id, name, city, lat, lon, beds, patient_load, emergency_index |
| `medicines` | Catalogue | id, name, unit, criticality, shelf_life_days, alternatives, unit_cost |
| `consumption` | Daily usage | day, date, hospital_id, medicine_id, units, units_base, split (history or future) |
| `batches` | Current stock | batch_id, hospital_id, medicine_id, qty, expiry_date, received_date, source |
| `lead_times` | Supplier lead | hospital_id, medicine_id, lead_days |
| `transport` | Road matrix | from_id, to_id, km, hours |
| `transfers` | Exchange moves | medicine, from, to, qty, allocations (batches), status, awaiting, origin, reason, hours |
| `offers` | Surplus offers | hospital, medicine, batch, qty, remaining, expiry, status |
| `requests` | Stock requests | hospital, medicine, qty, remaining, needed_within_days, status |
| `messages` | Threads and notifications | sender, recipient, kind, body, transfer/offer/request ids |

`units_base` stores consumption without the outbreak, used for the counterfactual scenario. Rows with `split = future` are held-out ground truth, hidden from the models.

### Key configuration (`backend/app/config.py`)
Simulation date `2026-10-08`; history 120 days; held-out 14 days; forecast horizon 14 days; safety buffer 3 days; outbreak start history day 92 on Oseltamivir; seed 2026.

## 12. API surface

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/meta` | GET | Hospitals, medicines, scenarios, default weights, transport matrix |
| `/api/overview` | GET | Full analysis for a scenario and weight set: cells, warnings, spikes, expiry, plan, verification, orders, impact, metrics, KPIs |
| `/api/forecast` | GET | Series with forecast, band and anomaly flags for a medicine and hospital |
| `/api/hospital/{id}` | GET | Drill-down for one hospital |
| `/api/judge` | GET | Reference-scenario ledger, weekly demand, verification |
| `/api/compare` | GET | With versus without system results |
| `/api/exchange` | GET | Exchange board for a hospital or the whole network |
| `/api/exchange/send-plan` | POST | Dispatch optimiser moves as pending transfers |
| `/api/transfers/{id}/action` | POST | Approve, dispatch or receive a transfer |
| `/api/offers`, `/api/offers/{id}/claim` | POST | Broadcast surplus; claim it |
| `/api/requests`, `/api/requests/{id}/respond` | POST | Request stock; donor responds |
| `/api/messages` | POST | Add a message to a thread |
| `/api/assistant` | POST | Ask a question; returns answer, mode and tools used |
| `/api/reset` | POST | Regenerate data and clear exchange state |

Scenario (`outbreak` or `normal`) and priority weights (`w_<factor>`) are query parameters. Interactive API documentation is served at `/docs`.

## 13. Quality, validation and testing

### Automated (9 tests, about 6 s)
Reference scenario sums to 20,000 and the weekly series is exact; units before equal units after and ledger rows balance; all verification checks pass for both scenarios and no shipped batch expires within 2 days of arrival; outbreak-adjusted forecast beats seasonal-naive and detects the outbreak only in the outbreak scenario; with-system impact beats without-system; warnings state days to stock-out and lead time; transfer lifecycle including wrong-party rejection and non-re-proposal of delivered moves; offer and claim; request and respond; assistant answers are built from tool data.

### Model quality targets and how they are checked
| Area | Check |
|---|---|
| Forecast | WAPE against seasonal-naive on a rolling backtest, reported honestly in the UI |
| Intervals | P10 to P90 coverage near the nominal 80% |
| Spike detection | Detection lag after outbreak onset on injected outbreaks |
| Optimiser | Constraint checks (conservation, shelf life, arrival before stock-out, donor cover) on every plan |
| Impact | With-system versus without-system unmet doses and waste on held-out demand |

### Known limitations and honest caveats
- Consumption, stock and the outbreak are simulated; model metrics describe performance on that simulation, not on real hospital data.
- Some bed counts, outpatient loads, prices and shelf lives are estimates (see `DATA_SOURCES.md`).
- The Gemini path is untested against the live API.
- No authentication or role enforcement; "Acting as" is a UI convenience, not a security boundary.
- The system recommends but does not place supplier orders.

## 14. Roadmap

| Horizon | Items |
|---|---|
| Near term | Verify and re-source estimated fields; live-API test of the Gemini path; frontend automated tests; CI running backend tests, type-check and build |
| Mid term | Authentication and per-hospital roles; ingestion adapters for real consumption and stock feeds (CSV or API); transport capacity and vehicle scheduling; supplier lead-time variance in risk |
| Long term | Per-medicine cold-chain constraints; substitute-drug logic inside the optimiser; uncertainty-aware (safety-stock) redistribution; procurement integration; mobile client |

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Models tuned to simulated data overstate real accuracy | Misplaced trust | Rolling-origin backtest against a naive baseline; limitations stated in-product and in docs |
| Real data differs in format or quality | Integration effort | Narrow table schema; generator and loader isolated in one module |
| Optimiser infeasible or slow on a larger network | No plan shown | Per-medicine decomposition; rescue pass; deterministic fallback to partial plan |
| LLM produces unsupported numbers | Loss of trust | Tool-calling only; answers cite tool output; rules-mode fallback |
| Stale analysis after stock changes | Wrong recommendations | Cache invalidated on delivery and reset; Reset demo regenerates cleanly |
| Unauthenticated API in a shared environment | Unauthorised actions | Documented as out of scope; add auth before any non-demo deployment |

## 16. Assumptions

1. A hospital network administrator can coordinate transfers among member hospitals.
2. Road drive time plus a 0.5 hour loading allowance is an adequate transfer-time estimate within the district.
3. Supplier lead times are fixed per medicine plus a 0, 1 or 2 day remoteness penalty derived from road distance to the district hub (Wenlock).
4. The reference scenario's stock split across hospitals, expiry dates and lead times are defined by this project and editable in `backend/app/generate.py`.
5. A single-tier network (hospitals only) is sufficient for the MVP.

## 17. Repository layout and run instructions

```
backend/
  app/        config, db, generate, fetch_routes, forecast, inventory, priority,
              optimizer, engine, exchange, assistant, main; data/routes.json
  tests/      conftest.py, test_system.py
  DATA_SOURCES.md  requirements.txt  .env.example
frontend/     Vite + React + TypeScript (src/App.tsx, api.ts, components/ui.tsx)
README.md     Setup, run, test and demo walkthrough
prd1.md       This document
```

Quick start (full instructions in `README.md`):
```powershell
cd backend; python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt
cd ..\frontend; npm install; npm run build
cd ..\backend; .venv\Scripts\python -m uvicorn app.main:app --port 8000   # open http://127.0.0.1:8000
```
