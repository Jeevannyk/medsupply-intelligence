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

### Reset to a clean demo state

Click **Reset demo** in the header (or `POST /api/reset`). It regenerates the database and clears all transfers, offers, requests and messages. Do this before each demo run.

### Optional: Gemini assistant

```powershell
$env:GEMINI_API_KEY = "your-key"        # optional: $env:GEMINI_MODEL = "gemini-2.5-flash"
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Without a key the assistant calls the same backend tools and fills answer templates (answer footer shows `mode: rules`). With a key it shows `mode: gemini:...`. If Gemini fails it falls back to rules and says so. The Gemini path has not been tested against the live API.

## 4. Test

### Automated (backend, about 6 seconds)

```powershell
cd backend
.venv\Scripts\python -m pytest -q tests
```

Expected: `9 passed`. Tests use a separate temp database, so they never touch `medsupply.db` or a running server. They cover:

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

Start from **Reset demo**.

1. **KPI strip** shows 3 hospitals at risk, 8 outbreak signals, "✓ all checks".
2. **Inventory**: red/orange cells are hospitals that run out before resupply. Click a cell and the Predicted-demand chart switches to it. Click a hospital name for the drill-down drawer.
3. **Predicted demand**: pick Oseltamivir, Whole network. Shows actuals, the forecast, an 80% band, red anomaly dots and a "Spike detected" line. The backtest table shows seasonal naive about 26% WAPE vs the outbreak-adjusted model about 5%.
4. **Shortage risk**: sentences like "…runs out of Oseltamivir 75 mg in 5 days (lead time 9 days): an order placed today arrives too late…" plus supplier orders to place today.
5. **Expiry risk**: A.J. Hospital's Oseltamivir batch, with the stock-vs-demand reasoning. Click **Broadcast surplus offer** (as Network admin).
6. **Redistribution**: map arrows and move cards with reasons; verification list all ✓; ledger rows where before − out + in = after; network totals unchanged (Oseltamivir 20,000 → 20,000).
7. **Exchange flow**: click **Send plan to hospitals** (as Network admin), then:
   - Set **Acting as** to the donor hospital (for example B). It shows "N awaiting you". Click **approve**, then **dispatch**.
   - Set **Acting as** to the recipient (for example A). Click **receive**. The transfer shows delivered, and in Inventory the stock numbers have moved while the network total is the same.
   - Open **thread** on a transfer, write a reply, and check the other hospital sees it in Messages.
8. **Hospital request**: as a hospital, use **Request stock** (Ceftriaxone, 100). A request appears with AI-suggested donors; act as one of them and click **respond**.
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
