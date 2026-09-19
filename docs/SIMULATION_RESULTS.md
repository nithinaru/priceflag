# Simulation results — six stores, known truth

Every number here comes from running the production engine — forecast, cohort planner, price writer, evaluator, guardrails, rollback — over **simulated stores whose true price elasticity is known and hidden from the model**. They are projections of what the beta should do, not merchant results. Regenerate with `npx tsx scripts/simulate-portfolio.ts`.

Generated 2026-09-17T01:11:37.591Z · simulated clock starts 2026-09-16 · 5 noise seeds per cell · 150 full rollouts.

## Headline

| What | Number | How it is measured |
|---|---|---|
| Forecast range contains the realized outcome | **93%** | Healthy +8% and −10% rollouts; realized units change over the 90-day window vs the forecast's low–high range |
| Typical forecast miss | **4.7 pts** | Median \|realized − expected\| units change, percentage points |
| Same, with no store-specific fit (assumption tier) | 97% in range · 1.7 pts miss | What the product shows a store with no usable price history |
| False pauses on healthy rollouts | **7%** | A guardrail pause with no demand shock injected |
| Demand shocks caught | **82%** · median day 6 | Shoppers react 40–50% worse than the curve; days from shock to pause |
| Every price restored after rollback | **100%** | Fake Shopify re-read against frozen baselines after every run |
| Elasticity recovered within ±0.3 | **29%** · MAE 0.58 · 80% interval covers truth 87% | Lane C's fitter on observable rows vs hidden truth, over estimated SKUs |

## The stores

| Store | Size | SKUs | Units/day | Estimated SKUs | Within ±0.3 | Fit MAE | 80% CI covers truth | Tiers (fitted / partial / assumption) |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Morning Root Botanicals | small | 16 | 41.1 | 10/14 | 10% | 0.84 | 100% | 0 / 10 / 4 |
| Fenwick Leather | small | 19 | 63.6 | 11/18 | 18% | 0.54 | 91% | 0 / 11 / 7 |
| Northline Apparel | medium | 73 | 241 | 38/72 | 5% | 0.94 | 53% | 0 / 38 / 34 |
| Kilnworks Home | medium | 65 | 237.2 | 39/64 | 46% | 0.38 | 95% | 0 / 39 / 25 |
| Ridgeline Supply Co. | large | 282 | 1006.5 | 158/280 | 46% | 0.41 | 91% | 0 / 158 / 122 |
| Atlas Beauty | large | 322 | 1321.8 | 177/320 | 47% | 0.36 | 94% | 0 / 177 / 143 |

## Forecast accuracy (healthy rollouts)

| Store | Scenario | Runs | Forecast tier | In range | Median miss (pts) | Mean miss (pts) | Median revenue miss | False pause | Completed | Rollback |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Morning Root Botanicals | +8% price increase, fitted model | 5 | assumption×4 partial×1 | 100% | 5.5 | 5.7 | 67% | 0% | 100% | 100% |
| Morning Root Botanicals | −10% price cut, fitted model | 5 | assumption×4 partial×1 | 80% | 10.3 | 12.8 | 47% | 20% | 80% | 100% |
| Morning Root Botanicals | +8% increase, no store fit (assumption tier) | 5 | assumption×5 | 100% | 1.4 | 2.3 | 36% | 0% | 100% | 100% |
| Fenwick Leather | +8% price increase, fitted model | 5 | assumption×5 | 60% | 4.4 | 11.5 | 49% | 40% | 60% | 100% |
| Fenwick Leather | −10% price cut, fitted model | 5 | assumption×5 | 100% | 5.0 | 4.3 | 91% | 0% | 100% | 100% |
| Fenwick Leather | +8% increase, no store fit (assumption tier) | 5 | assumption×5 | 80% | 1.0 | 3.6 | 54% | 20% | 80% | 100% |
| Northline Apparel | +8% price increase, fitted model | 5 | assumption×5 | 80% | 5.2 | 5.8 | 323% | 20% | 80% | 100% |
| Northline Apparel | −10% price cut, fitted model | 5 | assumption×5 | 100% | 9.3 | 7.6 | 360% | 0% | 100% | 100% |
| Northline Apparel | +8% increase, no store fit (assumption tier) | 5 | assumption×5 | 100% | 1.5 | 2.1 | 80% | 0% | 100% | 100% |
| Kilnworks Home | +8% price increase, fitted model | 5 | assumption×5 | 100% | 3.3 | 3.1 | 106% | 0% | 100% | 100% |
| Kilnworks Home | −10% price cut, fitted model | 5 | assumption×5 | 100% | 4.9 | 4.6 | 51% | 0% | 100% | 100% |
| Kilnworks Home | +8% increase, no store fit (assumption tier) | 5 | assumption×5 | 100% | 2.6 | 2.2 | 37% | 0% | 100% | 100% |
| Ridgeline Supply Co. | +8% price increase, fitted model | 5 | assumption×5 | 100% | 1.3 | 1.6 | 56% | 0% | 100% | 100% |
| Ridgeline Supply Co. | −10% price cut, fitted model | 5 | assumption×5 | 100% | 1.3 | 2.2 | 32% | 0% | 100% | 100% |
| Ridgeline Supply Co. | +8% increase, no store fit (assumption tier) | 5 | assumption×5 | 100% | 1.9 | 2.3 | 19% | 0% | 100% | 100% |
| Atlas Beauty | +8% price increase, fitted model | 5 | assumption×5 | 100% | 1.7 | 2.2 | 50% | 0% | 100% | 100% |
| Atlas Beauty | −10% price cut, fitted model | 5 | assumption×5 | 100% | 2.1 | 2.7 | 54% | 0% | 100% | 100% |
| Atlas Beauty | +8% increase, no store fit (assumption tier) | 5 | assumption×5 | 100% | 3.3 | 3.0 | 125% | 0% | 100% | 100% |

## Guardrails (injected demand shocks)

| Store | Scenario | Runs | Caught | Median days to pause | Rollback |
|---|---|---:|---:|---:|---:|
| Morning Root Botanicals | +8%, shoppers react 40% worse than the curve from day 4 | 5 | 60% | 10 | 100% |
| Morning Root Botanicals | +8%, demand halves on repriced SKUs from day 2 | 5 | 60% | 8 | 100% |
| Fenwick Leather | +8%, shoppers react 40% worse than the curve from day 4 | 5 | 60% | 7 | 100% |
| Fenwick Leather | +8%, demand halves on repriced SKUs from day 2 | 5 | 100% | 8 | 100% |
| Northline Apparel | +8%, shoppers react 40% worse than the curve from day 4 | 5 | 100% | 3 | 100% |
| Northline Apparel | +8%, demand halves on repriced SKUs from day 2 | 5 | 100% | 9 | 100% |
| Kilnworks Home | +8%, shoppers react 40% worse than the curve from day 4 | 5 | 40% | 8 | 100% |
| Kilnworks Home | +8%, demand halves on repriced SKUs from day 2 | 5 | 100% | 4 | 100% |
| Ridgeline Supply Co. | +8%, shoppers react 40% worse than the curve from day 4 | 5 | 100% | 4 | 100% |
| Ridgeline Supply Co. | +8%, demand halves on repriced SKUs from day 2 | 5 | 100% | 2 | 100% |
| Atlas Beauty | +8%, shoppers react 40% worse than the curve from day 4 | 5 | 80% | 5 | 100% |
| Atlas Beauty | +8%, demand halves on repriced SKUs from day 2 | 5 | 80% | 1 | 100% |

## How to read this honestly

- **Simulated, with truth known.** Real stores have no ground truth, which is exactly why these numbers exist: they are the only place the forecast can be scored against what actually would have happened.
- **The forecast never sees the truth.** Elasticity is estimated by the Python champion (`elasticity-poisson-eb-1.0`) from units, list price, promo and stockout flags — the columns a real Shopify sync produces. The simulator then generates the future from the hidden elasticity.
- **Small stores detect slower.** Below about three expected units a day a zero is noise, so the low-volume floor deliberately refuses to count those days. That is the "quiet Tuesday" protection, and it costs detection speed on tiny catalogs.
- **Beta posture: pause, never auto-revert.** A caught shock pauses and emails a recommendation; the restore is a merchant click. The rollback row measures that click.
- **Revenue misses are wider than unit misses** because revenue compounds the unit error with price and promo mix over a 90-day window.

