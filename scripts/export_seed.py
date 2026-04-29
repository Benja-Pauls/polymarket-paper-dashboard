"""Export seed data for the polymarket-paper-dashboard.

Writes a single JSON file the dashboard's TS seed script consumes:
  - watched_markets: list of {condition_id, question, category,
                              resolution_timestamp, resolved, payouts,
                              winner_outcome_idx, token_to_outcome}
  - generated_at: ISO timestamp

Source data: ../polymarket-insider-detection/data/{labels,raw/goldsky}
Filter: tradeable_* category AND not yet resolved (resolution in the
future, or no resolution timestamp known).

Run from the dashboard project (uses the research repo as a read-only
data source):

    source /Users/ben_paulson/Documents/Personal/Stock_Portfolio/.venv/bin/activate
    python scripts/export_seed.py
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# This script lives in polymarket-paper-dashboard/scripts/ but reads
# parquet files from the sibling research repo.
DASHBOARD_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_ROOT = DASHBOARD_ROOT.parent / "polymarket-insider-detection"
ROOT = RESEARCH_ROOT  # alias used below for parquet paths

TRADEABLE = {
    "tradeable_geopolitical",
    "tradeable_political",
    "tradeable_corporate",
    "tradeable_crypto",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--output",
        default=str(DASHBOARD_ROOT / "scripts" / "seed_data.json"),
        help="Path to write seed JSON",
    )
    ap.add_argument(
        "--max-markets", type=int, default=10_000, help="Cap number of watched markets"
    )
    args = ap.parse_args()

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Load tradability classifier
    trad_paths = [
        ROOT / "data" / "labels" / "market_tradability.parquet",
        ROOT / "data" / "labels" / "market_tradability_expanded.parquet",
        ROOT / "data" / "labels" / "market_tradability_forward_stratified.parquet",
    ]
    trad_parts = []
    for p in trad_paths:
        if p.exists():
            t = pd.read_parquet(
                p, columns=["condition_id", "question", "category_tradability"]
            )
            trad_parts.append(t)
    if not trad_parts:
        raise SystemExit("no tradability parquet found")
    trad = pd.concat(trad_parts, ignore_index=True).drop_duplicates("condition_id")
    print(f"[load] tradability: {len(trad):,} markets")

    trad = trad[trad["category_tradability"].isin(TRADEABLE)].copy()
    print(f"[filter] tradeable_* only: {len(trad):,} markets")

    # Load resolutions + token_to_outcome (where known)
    mk_paths = [
        ROOT / "data" / "raw" / "goldsky" / "markets.parquet",
        ROOT / "data" / "raw" / "goldsky" / "markets_forward_2026_04_22_to_28.parquet",
        ROOT / "data" / "raw" / "goldsky" / "markets_forward_stratified_jan_apr_2026.parquet",
    ]
    mk_parts = []
    for p in mk_paths:
        if p.exists():
            mk_parts.append(
                pd.read_parquet(
                    p,
                    columns=[
                        "condition_id",
                        "resolution_timestamp",
                        "payouts",
                        "token_to_outcome",
                    ],
                )
            )
    if mk_parts:
        mk = pd.concat(mk_parts, ignore_index=True).drop_duplicates("condition_id")
    else:
        mk = pd.DataFrame(
            columns=[
                "condition_id",
                "resolution_timestamp",
                "payouts",
                "token_to_outcome",
            ]
        )
    print(f"[load] markets catalog: {len(mk):,} entries")

    merged = trad.merge(mk, on="condition_id", how="left")

    now = int(time.time())
    rows: list[dict] = []
    for _, r in merged.iterrows():
        cid = str(r["condition_id"])

        # Resolution / winner
        res_ts = r.get("resolution_timestamp")
        try:
            res_ts_int = int(res_ts) if pd.notna(res_ts) else None
        except (TypeError, ValueError):
            res_ts_int = None

        payouts = r.get("payouts")
        winner = None
        resolved = 0
        payouts_list = None
        if payouts is not None and hasattr(payouts, "__len__") and len(payouts) >= 2:
            try:
                payouts_list = [str(p) for p in payouts]
                for i, p in enumerate(payouts):
                    try:
                        if float(p) > 0.5:
                            winner = i
                            break
                    except Exception:
                        pass
                resolved = 1 if winner is not None else 0
            except Exception:
                payouts_list = None

        # Skip markets that are already resolved (per parquet snapshot) —
        # we can't paper-trade them. NOTE: most catalog markets in the snapshot
        # ARE resolved; the seed is mostly tradeable_* markets where we don't
        # yet have catalog metadata. The cron looks up resolution + token map
        # on demand from Goldsky's `activity-subgraph` when it sees a trade
        # in a market it doesn't have full metadata for.
        if resolved == 1:
            continue

        # token_to_outcome -> {token_id: outcome_idx}
        t2o_clean: dict[str, int] | None = None
        t2o = r.get("token_to_outcome")
        # pandas: NaN dict cell is a float NaN (truthy != None). Use isinstance.
        if isinstance(t2o, dict):
            t2o_clean = {}
            for tid, oi in t2o.items():
                if oi is None:
                    continue
                try:
                    if pd.isna(oi):
                        continue
                    t2o_clean[str(tid)] = int(oi)
                except (TypeError, ValueError):
                    continue
            if not t2o_clean:
                t2o_clean = None

        rows.append(
            {
                "condition_id": cid,
                "question": (
                    str(r.get("question") or "") if pd.notna(r.get("question")) else None
                ),
                "category": str(r["category_tradability"]),
                "resolution_timestamp": res_ts_int,
                "resolved": resolved,
                "winner_outcome_idx": winner,
                "payouts": payouts_list,
                "token_to_outcome": t2o_clean,
            }
        )

        if len(rows) >= args.max_markets:
            break

    print(f"[ready] {len(rows):,} unresolved tradeable markets after filter")

    n_with_tokens = sum(1 for r in rows if r["token_to_outcome"])
    print(
        f"[stats] {n_with_tokens:,} markets have token_to_outcome maps "
        f"(needed for live trade decoding)"
    )

    # Sort: nearest resolution first
    rows.sort(key=lambda r: r["resolution_timestamp"] or (1 << 60))

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_markets": len(rows),
        "n_with_token_map": n_with_tokens,
        "watched_markets": rows,
    }

    with open(out_path, "w") as f:
        json.dump(payload, f)
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"[write] {out_path} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
