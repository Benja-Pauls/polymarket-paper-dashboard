"""Export condition_id -> category lookup index for the cron classifier.

The dashboard's `sync-open-markets` cron consults this index BEFORE falling
back to LLM classification, so any of the 15.5K already-labelled markets is
classified for free.

Output: scripts/label_index.json
  {
    "generated_at": "...",
    "n": 15567,
    "labels": {
      "<condition_id_lowercase>": "tradeable_geopolitical",
      ...
    }
  }

Run:
    source /Users/ben_paulson/Documents/Personal/Stock_Portfolio/.venv/bin/activate
    python scripts/export_label_index.py
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DASHBOARD_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_ROOT = DASHBOARD_ROOT.parent / "polymarket-insider-detection"


def main() -> None:
    out_path = DASHBOARD_ROOT / "scripts" / "label_index.json"

    label_paths = [
        RESEARCH_ROOT / "data" / "labels" / "market_tradability.parquet",
        RESEARCH_ROOT / "data" / "labels" / "market_tradability_expanded.parquet",
        RESEARCH_ROOT / "data" / "labels" / "market_tradability_forward_stratified.parquet",
    ]
    parts = []
    for p in label_paths:
        if p.exists():
            parts.append(
                pd.read_parquet(p, columns=["condition_id", "category_tradability"])
            )
    if not parts:
        raise SystemExit("no labels parquet found")
    df = pd.concat(parts, ignore_index=True).drop_duplicates("condition_id")
    print(f"[load] {len(df):,} labelled markets across {len(parts)} files")

    # Lowercase condition_id for case-insensitive lookup downstream.
    labels: dict[str, str] = {}
    for cid, cat in zip(df["condition_id"], df["category_tradability"]):
        if not cid or not cat:
            continue
        labels[str(cid).lower()] = str(cat)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n": len(labels),
        "labels": labels,
    }
    with open(out_path, "w") as f:
        json.dump(payload, f)
    size_kb = out_path.stat().st_size / 1024
    print(f"[write] {out_path} ({size_kb:.0f} KB, {len(labels):,} labels)")


if __name__ == "__main__":
    main()
