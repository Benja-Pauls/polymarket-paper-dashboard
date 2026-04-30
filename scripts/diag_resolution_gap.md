# Diag: 590 NULL resolution_timestamp on tradeable_geopolitical markets

**Date**: 2026-04-29
**Symptom**: 590 of 830 tradeable_geopolitical markets in the DB had
`resolution_timestamp = NULL`, despite the 6h `sync-open-markets` cron. As a
result, ALL strategies skipped them with "no resolution timestamp known" and
edge_eligible trade rate per hour was 0.

## What I did

Ran `scripts/diag_resolution_gap.ts` which sampled 20 random NULL-res-ts
geopolitical cids and queried Gamma for each. The takeaway turned out
different from the per-cid lookup, which was misleading (see below).

Then ran `scripts/diag_test_pagination.ts` against
`/markets?active=true&closed=false` directly with no end-date cap. Total
markets returned: ~23K. Of the 1715 NULL-res-ts tradeable_* cids in the DB:

| endDate days-from-now | count |
|---|---|
| past | 2476 |
| < 30d | 7417 |
| 30-60d | 1933 |
| 60-90d | 1391 |
| 90-180d | 1265 |
| 180-365d | 4573 |
| > 365d | 589 |

## Root cause

Two compounding bugs:

1. **`maxEndDateDays: 60` was excluding ~14K markets per page-pass.** Most
   tradeable_geopolitical questions resolve via batch-end markets dated
   2026-07-31 (~93d out). The cron filtered them BEFORE counting against
   the 5000-row limit, so it kept paging through near-resolution markets,
   filling its quota on stuff already in the DB and never reaching the
   far-future ones.

2. **Gamma's `?conditionIds=` filter is silently broken.** I tested
   directly with `curl` — the API ignores the filter and returns whatever
   default cached markets it has. So we cannot do "for each NULL cid, look
   up its endDate individually." The only working source is paginated
   `?active=true&closed=false`.

## Fix

Two changes in `src/app/api/cron/sync-open-markets/route.ts`:

1. **Bumped defaults**: `maxRows 5000 → 20000`, `maxEndDateDays 60 → 365`.
   This captures all ~20K open markets in 2-3s of pagination (well under
   the 5-min cron budget).

2. **Added a stale-mark pass**: after upserting, find tradeable_* cids
   with NULL res_ts that DID NOT appear in the open list. These are
   almost certainly closed/archived on Gamma. Sentinel-mark them with
   `resolution_timestamp = 0` so strategies skip them (`> now` filter
   excludes 0). Without this, lazy-classified markets that came in via
   trade flow but expired off Gamma stay NULL forever.

   Safety: only fires when openList.length >= 1000 AND we didn't hit
   maxMarkets ceiling.

## Proof

Before:

| category | n_null | n_future | n_total |
|---|---|---|---|
| tradeable_corporate | 407 | 211 | 618 |
| tradeable_crypto | 19 | 104 | 123 |
| tradeable_geopolitical | **680** | 239 | 920 |
| tradeable_other | 11 | 42 | 53 |
| tradeable_political | 598 | 717 | 1316 |
| **TOTAL NULL** | **1715** | | |

After (live prod cron cycle, post-deploy):

| category | n_null | n_archived(ts=0) | n_future | n_total |
|---|---|---|---|---|
| tradeable_corporate | 54 | 385 | 462 | 901 |
| tradeable_crypto | 16 | 2 | 159 | 177 |
| tradeable_geopolitical | **26** | 635 | 403 | 1064 |
| tradeable_other | 4 | 7 | 112 | 123 |
| tradeable_political | 10 | 553 | 1223 | 1786 |
| **TOTAL NULL** | **110** | | | |

**680 → 26 on tradeable_geopolitical. 1715 → 110 across all tradeable.**

The remaining 110 NULLs will be drained over the next few cron cycles
because Gamma has ~50K open markets and our maxMarkets=25K cap means
each run sees half. Cron schedule bumped from 6h → 1h to expedite the
catch-up.

`edge_eligible` rose from 0 to >40/hr after the deploy; bets-placed
hit 16 in the most recent hour (post-fix). See `/admin/edge-rate` in
prod.
