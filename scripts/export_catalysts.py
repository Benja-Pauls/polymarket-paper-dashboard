"""Export market catalyst data for the polymarket-paper-dashboard.

Reads `data/features/market_catalysts_v2.parquet` from the sibling research
repo and writes a JSON file the dashboard's TS seed script consumes:
  - generated_at: ISO timestamp
  - n_catalysts: row count
  - catalysts: list of {condition_id, catalyst_ts, catalyst_source,
                        catalyst_confidence}

The dashboard's `scripts/seed.ts` upserts these rows into the
`market_catalysts` table, which strategies with `require_future_catalyst: true`
(e.g. `geo_deep_longshot_v3_catalyst`) consult at trade-evaluation time.

Run from the dashboard project (uses the research repo as a read-only
data source):

    source /Users/ben_paulson/Documents/Personal/Stock_Portfolio/.venv/bin/activate
    python scripts/export_catalysts.py
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# This script lives in polymarket-paper-dashboard/scripts/ but reads
# parquet files from the sibling research repo.
DASHBOARD_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_ROOT = DASHBOARD_ROOT.parent / "polymarket-insider-detection"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--output",
        default=str(DASHBOARD_ROOT / "scripts" / "catalyst_data.json"),
        help="Path to write catalyst JSON",
    )
    ap.add_argument(
        "--input",
        default=str(
            RESEARCH_ROOT / "data" / "features" / "market_catalysts_v2.parquet"
        ),
        help="Path to source catalyst parquet",
    )
    args = ap.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        raise SystemExit(f"catalyst parquet not found: {in_path}")

    df = pd.read_parquet(in_path)
    print(f"[load] {len(df):,} catalyst rows from {in_path}")

    rows: list[dict] = []
    skipped = 0
    for _, r in df.iterrows():
        cid = r.get("condition_id")
        ts_raw = r.get("catalyst_ts")
        if cid is None or pd.isna(cid) or ts_raw is None or pd.isna(ts_raw):
            skipped += 1
            continue
        try:
            ts_int = int(ts_raw)
        except (TypeError, ValueError):
            skipped += 1
            continue

        src = r.get("catalyst_source")
        conf = r.get("catalyst_confidence")
        rows.append(
            {
                "condition_id": str(cid),
                "catalyst_ts": ts_int,
                "catalyst_source": (
                    None
                    if src is None or (isinstance(src, float) and pd.isna(src))
                    else str(src)
                ),
                "catalyst_confidence": (
                    None
                    if conf is None or (isinstance(conf, float) and pd.isna(conf))
                    else str(conf)
                ),
            }
        )

    print(f"[ready] {len(rows):,} catalyst rows ready (skipped {skipped})")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_catalysts": len(rows),
        "catalysts": rows,
    }

    with open(out_path, "w") as f:
        json.dump(payload, f)
    size_kb = out_path.stat().st_size / 1024
    print(f"[write] {out_path} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
