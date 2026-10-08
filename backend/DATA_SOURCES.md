# Data sources: what is real, estimated, simulated

Network: 8 real hospitals of Dakshina Kannada (Mangaluru region). Ids A-H keep the scenario roles from the original synthetic network.

## Real / sourced

| Field | Source | Notes |
|---|---|---|
| Hospital coordinates | OpenStreetMap (Nominatim / Overpass) | Wikipedia's Wenlock coordinates are wrong (point ~8 km off); OSM used |
| Road km and drive time | OSRM driving profile on OSM, `app/data/routes.json` (re-run `python -m app.fetch_routes`) | +0.5 h loading allowance added in `generate.py` |
| A Wenlock: 1,000 beds, 1,050 OPD/day | [Wikipedia](https://en.wikipedia.org/wiki/Wenlock_District_Hospital); [Deccan Herald](https://www.deccanherald.com/india/karnataka/patients-flock-govt-hospital-pvt-2033839) (1,000-1,100/day) | |
| B A.J. Hospital: 512 beds | [CAHO profile](https://cpm.caho.in/public/CqpLogoPdf/202302241628AJ-Hospital-Research-Centre.pdf) | Other sources quote 810-1,104 (incl. medical college) |
| C Father Muller: 1,250 beds, 1,710 OPD/day | [hospital page](https://www.fathermuller.edu.in/nursing-college/hospital.php); OPD figure from web search | MCI doc says 930 beds |
| E Lady Goschen: 290 beds, ~1.5 lakh OPD/yr | [Udayavani](https://www.udayavani.com/english-news/separate-mother-child-hospital-at-lady-goshen); OPD from web search | Other source says 260 beds |
| F Puttur taluk hospital: 100 beds | [Deccan Herald](https://www.deccanherald.com/india/karnataka/mangaluru/finance-department-approves-300-bed-govt-hospital-in-puttur-says-local-mla-ashok-kumar-rai-3816188) | |
| H KVG Sullia: 682 beds, 1,130 OPD/day | [WHO SEARO listing](https://apps.searo.who.int/PHI/Institute/Details/466); OPD from web search | |
| Oseltamivir shelf life 24 months | Cipla label (WHO-PQ report) | Other makers 18-48 months |
| Insulin glargine shelf life 24 months | Unopened pen, refrigerated | |
| Ceftriaxone 1 g Rs 63.47/vial, Amox-Clav 500/125 Rs 18.62/tab, Salbutamol Rs 1.04/ml (x 2.5 ml = Rs 2.60 per nebule) | NPPA ceiling prices, 1 Apr 2025 (via [Business Standard](https://www.business-standard.com/industry/news/nppa-revises-ceiling-prices-for-over-900-drug-formulations-from-april-1-125032801282_1.html) and NPPA price-list mirrors) | Values taken from search results; primary NPPA PDF not opened. Verify before quoting |

## Estimated (no public figure)

| Field | How set |
|---|---|
| D CHC Moodbidri 30 beds | IPHS norm for a CHC |
| G Belthangady taluk hospital 100 beds | Karnataka 100-bed taluk hospital norm |
| patients/day for B, D, F, G | beds x 1.4 (median published OPD per bed: Wenlock 1.05, Father Muller 1.37, Lady Goschen 1.42, KVG 1.66) |
| emergency index | assumption by hospital type |
| Oseltamivir Rs 28, Insulin glargine Rs 320, ORS Rs 4 | unverified; Rs 320 is likely low for branded pens |
| Ceftriaxone / Amox-Clav / Salbutamol shelf life (540 / 540 / 365 d) | unverified |
| Supplier lead days | assumption; plus 0/1/2 days from road km to Wenlock (<20 / <50 / >=50 km) |

## Simulated

Daily consumption, current stock batches, expiry dates, and the outbreak. Per-hospital medicine consumption and stock are not published anywhere. The judge scenario (20,000 units; demand 2,000 to 5,500/week) is exact by construction.
