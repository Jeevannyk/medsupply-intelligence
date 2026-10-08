# MedSupply Intelligence: Singularity 2026, Track 2 MVP

"Know before the shortage." Forecasts medicine demand per hospital, predicts stock-outs against supplier lead times, flags stock that will expire unused, and redistributes stock between hospitals with a verified optimiser. Hospitals coordinate transfers through a built-in exchange.

Network: 8 real hospitals of Dakshina Kannada (Mangaluru region) with real coordinates and road times. Medicine consumption, stock and the outbreak are simulated. What is real, estimated or simulated is listed in [backend/DATA_SOURCES.md](backend/DATA_SOURCES.md).

## 1. Prerequisites

- Python 3.11+ (built and tested on 3.14)
- Node 20.19+ or 22.12+ (required by Vite 8) and npm (built and tested on Node 24)
- No API keys needed. Optional: a free Gemini key for the assistant.

## 2. One-time setup

```powershell
# from the project root
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt

cd ..\frontend
npm install
npm run build          # builds the UI into frontend/dist
```

## 3. Run

### Option A: one process (recommended for demo)

```powershell
cd backend
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Open **http://127.0.0.1:8000**. The backend serves the built UI and the API. The database `backend/medsupply.db` is created automatically on first start. API docs: http://127.0.0.1:8000/docs

### Option B: UI development (hot reload)

Terminal 1: start the backend as above. Terminal 2:

```powershell
cd frontend
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to port 8000.

### Optional: mock courier service (delivery by a third-party carrier)

Delivery can go by the donor's own vehicle, a courier, or a district pool. Own vehicle and district pool need nothing extra. For **courier** delivery, start the simulated carrier in a second terminal:

```powershell
cd backend
.venv\Scripts\python -m uvicorn carrier_mock.app:app --port 8001
```

It has its own database (`backend/carrier.db`), runs a trip in real time (`CARRIER_TRAVEL_SECONDS`, default 30) and reports pickup, delays and arrival back to the app by webhook (`CARRIER_URL`, `CARRIER_KEY` in `.env`; the defaults work locally). If it is not running, choosing "Courier" shows a clear error and the donor picks another mode.

Flow: approve transfer → donor arranges delivery → dispatch (donor sees a 6-digit handover code) → the truck drives its route on the **Logistics** map for 30 seconds (`LOGISTICS_TRAVEL_SECONDS`, the demo's compressed trip time; the real road time stays on the transfer) → only once it has arrived can the receiver confirm with the code and the units actually accepted. The server refuses an earlier receipt even with the right code. Short or damaged units are recorded as discrepancies; stock changes only on confirmation. Choose **Acting as: District logistics office** to assign pool vehicles. The Logistics page has a demo clock and "Delay" buttons so a late trip, and the plan reacting to it, can be shown in seconds.

### Reset to a clean demo state

Click **Reset demo** in the header (or `POST /api/reset`). It regenerates the database and clears all transfers, offers, requests and messages. Do this before each demo run.

### Optional: Gemini assistant

Copy `backend/.env.example` to `backend/.env` and paste the key after `GEMINI_API_KEY=` and `GEMINI_MODEL=gemini-3.1-flash-lite` (the model name is read only from `.env`; there is no default, and without it the assistant stays in rules mode). `.env` is gitignored. Restart uvicorn after editing it. A real environment variable (`$env:GEMINI_API_KEY`) takes priority over the file.

Without a key the assistant calls the same backend tools and fills answer templates (answer footer shows `mode: rules`). With a key it shows `mode: gemini:...`. If Gemini fails it falls back to rules and says so. The Gemini path has not been tested against the live API.

## 4. Test

### Automated (backend, about 6 seconds)

```powershell
cd backend
.venv\Scripts\python -m pytest -q tests
```

Expected: `20 passed`. Tests use a separate temp database, so they never touch `medsupply.db` or a running server. They cover:

| Test | Checks |
|---|---|
| judge scenario | 20,000 units; weekly demand exactly 2,000 → 2,875 → 3,750 → 4,625 → 5,500; units before = after; per-hospital ledger balances |
| plan verification | all 8 checks pass for both scenarios; no shipped batch expires within 2 days of arrival |
| forecast | outbreak-adjusted forecast beats seasonal-naive; outbreak detected only in the outbreak scenario |
| impact | with the system, unmet doses and waste are lower than without |
| warnings | text states days to stock-out and lead time |
| transfer lifecycle | pending → approved → in transit → delivered; wrong party is rejected (HTTP 400); stock moves; network total unchanged; delivered moves are not re-proposed |
| offer / claim | broadcast offer is matched to takers and claimed; claim creates a pending transfer |
| request / respond | request reaches donors; donor response creates a transfer awaiting the requester |
| assistant | answer is built from tool data; priority question routes to the priority tool |
| selective send | sending one selected move creates exactly one transfer and only that arrow leaves the plan; an empty selection sends nothing (HTTP 400) |
| admin is read-only | network admin cannot approve, decline, dispatch, receive or cancel (HTTP 400) |
| stock on receive | donor physical stock falls and recipient's rises only when the recipient confirms receipt |
| request / offer to one hospital | only the addressed hospital can accept or decline; accepting opens an agreed transfer; donor dispatches, receiver confirms; units conserved |
| broadcast request / offer | any other hospital may accept; you cannot accept your own; withdrawn or declined items are closed |
| admin and bad input | the admin cannot post, accept or act; self-addressed, unknown, zero-quantity and unfillable requests are rejected |
| emergency loans | with no spare stock, red hospitals still get loans, every verification check passes, and each loan explains what the donor keeps |

### Frontend type-check and build

```powershell
cd frontend
npm run typecheck
npm run build
```

### Quick API smoke test (server running)

```powershell
(Invoke-RestMethod http://127.0.0.1:8000/api/judge) | Select-Object stock_total, passed      # 20000, True
(Invoke-RestMethod http://127.0.0.1:8000/api/overview).kpis.plan_verified                    # True
$body = @{ question = "Which hospitals are at highest shortage risk next week?" } | ConvertTo-Json
(Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/assistant -ContentType "application/json" -Body $body).answer
```

### Manual end-to-end check in the UI (about 5 minutes)

The UI is a sidebar app: each item (Dashboard, Inventory, Demand forecast, Shortage risk, Expiry & wastage, Redistribution, Prioritisation, Hospital exchange, Network map, Impact, Scenario test, Hospital nodes, Medicines, AI assistant) opens as its own page in the same tab (`#/route`), and the Dashboard summarises them. The numbered steps below refer to these pages.

Start from **Reset demo**.

1. **KPI strip** shows 3 hospitals at risk, 8 outbreak signals, "✓ all checks".
2. **Inventory**: red/orange cells are hospitals that run out before resupply. Click a cell and the Predicted-demand chart switches to it. Click a hospital name for the drill-down drawer.
3. **Predicted demand**: pick Oseltamivir, Whole network. Shows actuals, the forecast, an 80% band, red anomaly dots and a "Spike detected" line. The backtest table shows seasonal naive about 26% WAPE vs the outbreak-adjusted model about 5%.
4. **Shortage risk**: sentences like "…runs out of Oseltamivir 75 mg in 5 days (lead time 9 days): an order placed today arrives too late…" plus supplier orders to place today.
5. **Expiry risk**: A.J. Hospital's Oseltamivir batch, with the stock-vs-demand reasoning. Click **Broadcast surplus offer** (as Network admin).
6. **Redistribution**: map arrows and move cards with reasons; verification list all ✓; ledger rows where before − out + in = after; network totals unchanged (Oseltamivir 20,000 → 20,000).
7. **Redistribution and emergency loans**. On Redistribution, as Network admin, tick one or more transfers (or press **Send** on a card) and press **Send selected**. Only those are sent; each leaves the list and the map. When nobody has stock above the normal 14-day safety reserve, the engine adds orange **emergency loans**: a donor with long cover lends what it can spare while keeping enough for its own resupply wait plus a 3-day buffer, and should reorder. Anything still uncovered appears under **Still short after transfers** with a supplier order and, if one is on hand, a substitute medicine.
8. **Hospital exchange** (switch **Acting as** to a hospital; the admin view is read-only). Each hospital has three tabs:
   - **Inbox**: *Needs your decision* (network proposals to approve or decline, and requests or offers addressed to you, with Accept or Decline) and *Open to everyone* (broadcast requests and offers from other hospitals; any hospital that can help accepts, choosing a quantity).
   - **Transfers**: accepting makes the transfer *agreed*. The donor presses **Dispatch**, the receiver presses **Confirm receipt**. In Inventory and the Dashboard the on-hand numbers change only now; before that they show `+incoming` / `−committed out`.
   - **New request / offer**: ask one hospital or broadcast to all; offer to one hospital or broadcast to all. **Your open posts** can be withdrawn.
9. **Priority**: pick Ceftriaxone. A ranks above E and H. H ranks lower than its demand suggests because it holds an alternative (Amoxicillin-Clavulanate). Move a weight slider, click **Apply & re-plan**, and watch the ranking and the transfers change.
10. **Impact**: toggle Before / After outbreak. "With system" shows fewer stock-outs, fewer unmet doses and less waste than "Without".
11. **Judge scenario** card: 20,000 units, the weekly demand series, per-hospital before/after, and "8/8 verification checks passed".
12. **AI assistant**: click the sample questions. Footer shows which backend tools supplied the data.
13. Header toggle **Before / no outbreak** flips the whole dashboard to the no-outbreak counterfactual (no spikes, fewer risks).

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| UI says "Backend not reachable" | Start uvicorn (step 3). In dev mode the backend must be on port 8000. |
| `http://127.0.0.1:8000` shows API JSON or 404 instead of the UI | Run `npm run build` in `frontend`, then restart uvicorn. |
| Port 8000 already in use | Stop the other process, or use `--port 8001` and change the proxy target in `frontend/vite.config.ts`. |
| Numbers look stale or odd after many clicks | Click **Reset demo**. |
| `ModuleNotFoundError` | Run commands from `backend` using `.venv\Scripts\python`, not the global Python. |
| Fresh data for different hospitals or prices | Edit `HOSPITALS` / `MEDICINES` in `backend/app/generate.py`. Road times come from `backend/app/data/routes.json` (re-fetch with `python -m app.fetch_routes`, needs internet). |

## 6. What each part does

| Step | Where | How |
|---|---|---|
| Data | `app/generate.py` | 8 hospitals, 6 medicines (criticality, shelf life, alternatives), daily consumption with weekly seasonality and an injected flu outbreak, expiry-dated batches, lead times, road-time matrix. 14 more days of hidden ground truth for the impact simulation. |
| Judge scenario | built into the data | Oseltamivir network stock is exactly **20,000**; weekly demand is exactly **2,000 → 2,875 → 3,750 → 4,625 → 5,500**. `GET /api/judge`. |
| Forecast | `app/forecast.py` | Global HistGradientBoosting, direct 1–14 day horizon, target normalised by the 28-day mean. A spike detector (z-score + ratio vs a 28-day baseline) flags outbreaks; flagged series blend in a damped log-linear trend. P10/P90 from backtest residuals. Backtest on the last 14 days vs seasonal-naive (MAE/MAPE/WAPE). |
| Shortage risk | `app/inventory.py`, `app/engine.py` | FEFO simulation of batches against the forecast gives days until stock-out. Compared with lead time: critical (an order today arrives too late), order now, watch. Warning text and order quantity. |
| Expiry | `app/engine.py` `_expiry` | Per batch: demand before expiry vs quantity, minus what earlier-expiring batches cover, gives projected waste with the reasoning spelled out. |
| Redistribution | `app/optimizer.py` | MILP per medicine (scipy HiGHS). Constraints: recipient need before resupply, donor keeps its own 14-day P90 demand, batch quantities, no shipping stock that can't be used before expiry, minimum lot size. Fair-share tiers: every hospital's first 25% of need is filled before anyone's remainder. A second rescue pass sends would-be-wasted stock to hospitals that would run out before it expires. |
| Verification | `app/engine.py` `verify` | 8 checks: network units conserved, no batch over-drawn, no expired-on-arrival stock, shortage transfers ≤ need, arrival before stock-out, donors stay covered, no new waste at recipients, per-hospital ledger balances. |
| Prioritisation | `app/priority.py` | Score 0–100 from patient load, emergency demand, medicine criticality, no alternative on hand, urgency. Weights adjustable in the UI and drive the optimiser. |
| Hospital exchange | `app/exchange.py` | Surplus offers (AI matches takers who can use the stock before it expires), stock requests (AI suggests donors), transfers with a pending → approved → in transit → delivered life cycle (delivery moves batches in the DB), per-transfer message threads. |
| Impact | `app/engine.py` `_outcome` | 14-day simulation on hidden true demand. Without the system: no transfers, hospitals reorder only when they run out. With: transfers plus proactive orders. Run for both outbreak and no-outbreak scenarios. |
| Assistant | `app/assistant.py` | Tool-calling over the analysis (shortages, expiry, plan, priority, hospital summary, outbreak signals, forecast, judge check). |

## 7. Current numbers (outbreak scenario, seed 2026)

- Oseltamivir network forecast WAPE: seasonal-naive 25.9% → model 14.8% → model + outbreak adjustment 5.4%.
- Outbreak starts 10 Sep; Oseltamivir spikes are flagged at 6 hospitals on 13–16 Sep.
- 10 transfers (3,792 units). All 8 verification checks pass. Projected waste on affected hospitals falls 1,474 → 211 units.
- Unmet doses over the next 14 days (hidden truth): 5,679 without the system → 1,196 with it.
- Some need remains uncovered by transfers (shown in the "Still short" box); the plan also lists supplier orders to place today.

Numbers change if you edit the generator or seed.


The truck routes on the Logistics map come from `backend/app/data/road_paths.json`: real OSRM driving geometry between every hospital pair (re-fetch with `python -m app.fetch_road_paths`, needs internet).
