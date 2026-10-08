"""Transparent priority score for hospitals competing for the same scarce supply.

score = 100 * sum(w_f * f) / sum(w), every factor f in [0, 1]:
  patient_load    patients/day relative to the busiest hospital
  emergency       half ER/ICU intensity, half this medicine's demand surge
  criticality     medicine tier (life-saving 1.0, essential 0.67, routine 0.33)
  no_alternative  1 if no substitute medicine is spare on site, falling to 0 at 14 days of cover
  urgency         1 when already out, 0 when stock outlasts lead time + 10 days
"""
from .config import SAFETY_DAYS

LABELS = {
    "patient_load": "Patient load",
    "emergency": "Emergency demand",
    "criticality": "Medicine criticality",
    "no_alternative": "No alternative on hand",
    "urgency": "Urgency (days to stock-out)",
}


def factors(*, patient_load, max_load, emergency_index, surge, criticality, alt_spare_days,
            has_alternatives, dts, lead) -> dict:
    f = {
        "patient_load": patient_load / max_load,
        "emergency": 0.5 * emergency_index + 0.5 * min(max(surge - 1.0, 0.0), 1.0),
        "criticality": criticality / 3,
        "no_alternative": 1.0 if not has_alternatives else 1 - min(max(alt_spare_days / 14, 0.0), 1.0),
        "urgency": 0.0 if dts is None else 1 - min(max(dts / (lead + SAFETY_DAYS + 7), 0.0), 1.0),
    }
    return {k: round(v, 4) for k, v in f.items()}


def score(f: dict, weights: dict) -> tuple[float, dict]:
    total_w = sum(weights.values()) or 1.0
    contrib = {k: 100 * weights[k] * f[k] / total_w for k in weights}
    return round(sum(contrib.values()), 1), {k: round(v, 1) for k, v in contrib.items()}


def explain(name: str, f: dict, contrib: dict, ctx: dict) -> str:
    parts = []
    if f["patient_load"] > 0.6:
        parts.append(f"high patient load ({ctx['patient_load']:,}/day)")
    if ctx["surge"] > 1.2:
        parts.append(f"demand up {int((ctx['surge'] - 1) * 100)}% vs baseline")
    elif ctx["emergency_index"] >= 0.8:
        parts.append("high ER/ICU intensity")
    if ctx["dts"] is not None and f["urgency"] > 0.5:
        parts.append(f"runs out in {ctx['dts']:.1f} days vs {ctx['lead']}-day lead time")
    if ctx["has_alternatives"] and f["no_alternative"] < 0.5:
        parts.append(f"has an alternative on hand ({ctx['alt_name']}, ~{ctx['alt_spare_days']:.0f} days), so lower need")
    elif not ctx["has_alternatives"] or f["no_alternative"] >= 0.99:
        parts.append("no alternative available")
    top = max(contrib, key=contrib.get)
    return f"{name}: " + ("; ".join(parts) if parts else "low pressure") + f". Biggest factor: {LABELS[top].lower()}."
