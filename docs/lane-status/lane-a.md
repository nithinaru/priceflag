# Lane A — Product UI · status

Owned paths: `app/**` (except `app/api/**`), `components/**`,
`docs/lane-status/lane-a.md`, `contracts/requests-lane-a.md`.

> **Update (after Lane B's B1/B2 landed):** the root scaffold is on `main`, so
> **`npm run build` now runs green in the repo itself** — 10 routes, 14 static
> pages, Lane A's pages and Lane B's API routes together — and `npm run typecheck`
> (shared + Lane B's strict pass) is clean. REQ-A-001 is **resolved**; the
> out-of-repo harness described under Sprint A1 is retired. Lane B kept the `@/*`
> alias, added no `tailwind.config.js`, and removed the four runtime dependencies
> they had pre-added, so Lane A is still dependency-free. `lib/` and `contracts/`
> now exist; `components/mock/engine.ts` is scheduled for deletion as A3 migrates
> the propose flow onto the real `ForecastResult` contract.

| Sprint | State |
|---|---|
| **A1 — Design system foundation** | ✅ done |
| **A2 — Catalog & COGS** | ✅ done |
| **A3 — Propose flow v2 + migration onto `lib/`** | ✅ done |
| **A4 — Rollout monitoring v2** | ✅ done |
| **A5 — Onboarding & sync** | ✅ done |
| **A6 — Post-rollout report & journal v2** | ⚠️ report done; **journal filters have an open hydration bug** |
| A7 — Polish, a11y, responsive | not started |
| A5 — Onboarding & sync | not started |
| A6 — Post-rollout report & journal v2 | not started |
| A7 — Polish, a11y, responsive | not started |

---

## Sprint A6 — report done, journal filters have an open bug

### 🐛 Open bug — `JournalTable` does not hydrate on a hard load

**Reproduce:** load `http://localhost:3111/journal` directly (full page load). The
filters and the CSV button render, but nothing responds — changing a select does
not filter, and no `Clear filters` button appears. Navigate to `/` and click
*Price journal* in the nav (a soft, client-side navigation) and **everything
works**.

**Diagnosis so far.** On a hard load the `<select>` DOM nodes carry **zero**
`__reactProps$*` keys; after a soft navigation they carry three. So the component
is not hydrating on first load and is fully functional afterwards. Confirmed with
real browser clicks and key presses, not just synthetic events.

**Ruled out:** the client chunk is bundled and served (`/journal` went from 187 B
to 3.94 kB and `app/journal/page-*.js` returns 200); `"use client"` is present and
first in the file; no `server-only` marker anywhere in `lib/`;
`lib/engine/journal.ts` and `lib/dates.ts` import nothing Node-only and do no
module-scope work; no console error, no unhandled rejection, and no error event
fires during mount.

**Not ruled out:** a server/client render mismatch inside the subtree that React
19 bails out of silently. The next thing to try is bisecting the component —
render it with the table only, then add the filter row, then the CSV button — and
checking `next build`'s RSC boundary for `components/domain/journal.tsx`, which is
imported by both a server page and this client component.

**Not shipped as working.** The journal still renders every entry correctly on
every load, which is the R18 requirement; only the filtering and export are
affected, and both are A6 additions rather than regressions.

### What did land

- **`/rollouts/[id]/report`** — the retention loop, rendering
  `rollout_report.schema.json`. Verified against the completed demo rollout: a 12%
  price cut sold **23% more units and still lost $1,857 of profit** over 13 days,
  which is exactly the lesson a clearance teaches.
- **The honesty rule this page turns on.** `predicted` only exists when the
  forecast stored on the rollout had a *fitted range*. On the `assumption` tier
  there was no range, so the report says **"we did not predict a range for this
  one, so there is nothing to score ourselves against"** and refuses to grade
  itself. Inventing a prediction after the fact to be judged against would buy a
  flattering screenshot and cost the product's credibility — this is the screen
  that decides whether a merchant believes the next forecast.
- **Demo rollouts now store their forecast** (`Rollout.forecast`), built from
  history *before* the rollout started, because that is all the merchant could
  have seen. Report aggregation uses Lane B's `sumReadings`; nothing is invented.
- **Journal v2** — filters mirroring `GET /api/journal`'s query parameters
  (`source`, `rollout_id`, `from`/`to`, search) and a CSV export that uses **Lane
  B's own `journalToCsv`**, so the downloaded file cannot drift from what
  `/api/journal.csv` will serve in B7. Blocked on the hydration bug above.

### Not started

**A7 (polish, a11y, responsive)** — not begun. The next session should fix the
hydration bug first, then run A7's contrast and keyboard audit across the eight
screens that now exist.

---

## Sprint A5 — done

Rebuilt around the three facts from Lane B's real-store sync, treated as **the
default first-run experience rather than edge cases**: 17 repriceable variants,
**no variant has a cost**, and **the store has zero orders**. A merchant
connecting a young store sees exactly that, and it has to read as encouraging and
actionable rather than broken.

### The problem that shaped the sprint

Ran the engine against that state before designing anything. With zero orders and
zero costs, `buildForecast` correctly returns: `units_per_day: 0`, breakeven
`direction: "undefined"` ("no order volume to break even against"), `fitted:
null`, and **five scenario rows that are all zero units and zero money**.

Every one of those is right. Rendered as-is they are a wall of zeros and
"unknown" — which is how a correct fallback chain ends up looking like a broken
app. So the forecast card now branches on `baseline.units_per_day <= 0`:

- the breakeven headline is replaced by a plain statement that **we cannot tell
  you what this change will do**, and why — not a hedge, a refusal to guess;
- the all-zeros scenario table is **suppressed entirely**, along with the
  engine's explanation sentence that points at it;
- a "what you can still rely on" panel takes its place: add costs and the
  per-product table below is exact today, the change can still be made safely,
  and the range starts building as orders arrive;
- the footer says "no sales recorded yet, so there is no baseline to compare
  against" instead of "based on 0 days, averaging 0 units a day".

The sequencing insight the whole sprint hangs on: **costs unlock value
immediately, orders cannot be rushed.** Margin arithmetic needs costs, not
history — so a store with no orders that adds costs gets real per-sale profit
figures on day one. That is why costs are step 2 and orders are stated once,
honestly, as "not yet".

### What landed

- **`/connect`** — the install path. Reads `lib/config.describeEnvironment()` (the
  same probe behind `GET /api/health`) rather than a UI flag, so it **cannot offer
  an install that would 404**: with Shopify credentials it hands off to
  `GET /api/auth`; without them the button says so and runs a clearly-labelled
  scripted sync instead. Includes what Priceflag will read and do in plain
  language, and the promise that names the product — never different prices for
  different shoppers.
- **`components/onboarding/sync-progress.tsx`** — renders
  `sync_progress.schema.json`. Never one undifferentiated bar: catalog and history
  finish independently, and the moment `catalog.ready` flips the merchant gets a
  real next action instead of watching history download (R24). `eta_seconds:
  null` renders as no ETA — never "calculating…". A failed poll is not a failed
  sync and says nothing.
- **`/products/costs`** — the focused cost pass. The catalog could already edit a
  cost in place, but that is the wrong shape when *none* of 26 variants has one.
  Type, Enter, land on the next. Each row saves on its own, and the moment a cost
  lands that row shows the profit and margin it just unlocked — the reward is the
  reason the screen exists. Only repriceable products appear; a cost on a gift
  card is busywork.
- **First-run guide on the overview** — three steps ordered by what unlocks what,
  plus a separate honest panel about having no orders.
- **`/settings`** — notification addresses, and the demo ↔ real explanation. The
  mode switch is **deliberately not a toggle**: which store Priceflag can reprice
  is a server setting, and a control that appeared to change it would be lying
  about something that governs whether real prices move. Event types are not
  configurable either — a merchant who can switch off "your prices were put back
  automatically" will one day not know their prices were put back automatically.

### QA

Verified the young-store state by temporarily stripping costs and order days from
the demo store, walking `/`, `/products/costs` and `/propose`, then reverting.
Confirmed: no dead ends (the start button is still there — a young store can
still change prices safely), the guardrail builder correctly warns these products
sell too rarely for a daily limit to bite, and Enter-to-advance on the cost screen
saves, moves focus and updates the counter.

**Still open for Lane B:** REQ-A-005 (two copy fixes in verbatim strings) and
REQ-A-006 (demo cannot reach `fitted`) — the latter is assigned to B6. Fitted
rendering continues to be verified by temporary injection during QA, reverted.

---

## Sprint A4 — done

A4's other deliverables — the stage timeline, breach states, the event log, the
prominent one-click rollback and the paused-for-external-change state — landed
with A1/A3 against real engine data. What was left was the chart and the kill
switch.

**The actual-vs-expected chart** — `components/rollout/orders-chart.tsx`,
hand-authored SVG, no chart dependency on a page merchants open on phones.

- The band is the point, so it is drawn first as a recessive fill with a defined
  edge; the actual line reads on top of it; markers are ringed in the surface
  colour so they stay legible against the band.
- Two series, so the legend is always present, and only the most recent value is
  direct-labelled — never a number on every point.
- **`band_floored` days break every series.** There is no honest band to draw, so
  the band and the expected line are segmented around them and the marker goes
  hollow. The actual line still spans them, because orders happened even on days
  the band cannot judge. A drawn range there would invite a reading the data
  cannot support.
- Stage boundaries are annotated in place ("Step 2 of 3") rather than being a
  second series. One axis, units only.
- Hover gives a crosshair-style tooltip carrying `readingSentence` verbatim; each
  point is focusable with the same sentence as its accessible name; and the table
  underneath is the table view, with the chart's own description pointing at it.

**The store-level kill switch** (R21) — `components/domain/kill-switch.tsx`, on
the overview, deliberately last on the page: findable, but never competing with
the screen's primary action. Unlike a single rollback it cannot be scoped down
afterwards, so the confirm button is armed by an explicit acknowledgement rather
than being one click. Wired to `POST /api/kill-switch`'s
`{ ok, affected_skus, message }`; disabled with a reason when nothing is live.

### Cross-lane drift, and what it cost

**Lane B changed `lib/demo/generator.ts` in B2 after A3 was built on it**, which
moved every order-day number. The effect on Lane A was not a type error — it was
a *narrative* break: the demo's healthy rollout started tripping its guardrail, so
`/` and `/rollouts` showed an auto-rollback where the demo is supposed to show a
change holding up. Caught in browser QA, not by the compiler.

Fixed by making the fixture robust rather than re-fitting it:

- the healthy rollout now runs on **unmodified demand** — actuals are the store's
  own history, which by construction sits inside a band built from that history;
- its deliberate "one low day that recovered" is gone, because the store's own
  trading already produces one — manufacturing a dip on top of real noise is what
  broke;
- guardrail thresholds are set per rollout to survive ordinary seasonality (45%
  on the 6-SKU selection, 55% on the clearance). Worth knowing for its own sake:
  **the bracket band on a small selection is noisy enough that a 30% limit trips
  on ordinary trading.** That is PRD risk #2 showing up in practice, and it is the
  argument for Lane C's C5 breach probabilities replacing raw thresholds.

**Also:** commit `432b5ae "Shopify integration"` (Lane B's session) contains two
Lane A files — `components/demo/store.ts` and `components/demo/rollouts.ts` — and
nothing else. They were untracked Lane A work-in-progress swept up by a broad
`git add`. No content was lost and no history needs rewriting, but it is worth
flagging: BUILD_BRIEF §2.3 asks everyone to stage their own paths explicitly,
because all three sessions share one working tree.

---

## Sprint A3 — done

**`components/mock/engine.ts` is deleted.** The whole UI now runs on Lane B's
types, engine and contracts. `npm run build` and `npm run typecheck` (both passes)
are green.

### The propose flow (the sprint's actual deliverable)

`/propose` — `components/propose/*` plus a server action.

- **The forecast card renders `contracts/forecast_result.schema.json` and computes
  nothing.** Order is the argument (R6/R8): `breakeven.sentence` first as the
  headline, because it is margin arithmetic that holds whatever customers do; then
  the fitted range *only when the engine produced one*; then the confidence tier
  with the engine's own `confidence_explanation`; then `warnings` as notices; then
  `scenarios` + `assumptions` behind a collapsed "Show your work"; then the
  per-`products` breakdown with `compare_at_action` and `exclusion_reason`.
- **The range is drawn** — `components/propose/range-bar.tsx`, hand-authored SVG,
  no chart dependency. One series so no legend box, a dashed "no change" reference
  line (whether the range crosses zero is the real question), the point estimate as
  a ringed marker on a recessive band, values direct-labelled at the ends. A range
  entirely below zero tints as breach for **profit only** — orders falling when a
  price rises is the expected trade, and painting that red would be editorialising.
- **The guardrail builder is one sentence with editable blanks** (R10), not a form,
  because that is the only shape in which a merchant can read back what they have
  agreed to. Its live preview translates the percentage into units — "you sell
  about 63.3 units a day, so we would act on a day below roughly 44.3 units" —
  since that is the number a merchant recognises. **The string on screen is the
  string stored** in `guardrails.rules[].sentence`; this component is the author of
  the record, never a view of it.
- `app/propose/actions.ts` mirrors `POST /api/forecast` and `POST /api/rollouts`
  as server actions, debounced at 350 ms with last-write-wins. Running the engine
  server-side also keeps 180 days × 14 variants of history out of the browser.
- The create action **says what actually happened**: in demo mode nothing is sent
  to Shopify, and the panel says so rather than implying a write. No button on the
  screen goes nowhere.

### The migration

`components/demo/` replaces the mock, in two files that hold **no logic**:

- `store.ts` hydrates `generateDemoStore()` into full `Product` / `OrderDay` rows.
  It pins `endDay` and `now` — the generator defaults its last day to "yesterday",
  which would make every build differ and every statically-rendered page disagree
  with the next deploy (CLAUDE.md: no `Date.now()` in demo logic).
- `rollouts.ts` builds six demo rollouts covering **all seven statuses** by
  *simulating the evaluator*, not by asserting outcomes: stages from
  `normalizeStages`, frozen baselines and cohorts from `planRolloutVariants`,
  expected bands from `bracketBand` + `combineBands` over **pre-change days only**,
  breach flags and streaks from `evaluateGuardrails`, and the advance / hold /
  rollback / complete decision from `decideNext`. The rolled-back rollout rolls
  back because a guardrail fired; the completed one completes because it held up.
  Verdicts, health and their sentences come from `lib/engine/readings.ts` at render
  time, so **the UI cannot show a verdict the machine did not compute.**
- The one invented thing is the **demand response** to a price change
  (`demand_factor`), because a demo store that cannot show a breach leaves that UI
  unreachable and untested. It is deterministic, it shapes observed demand rather
  than the product's behaviour, and it never reaches a forecast.
- `getLive()` returns the `GET /api/live` shape from `contracts/api.md` verbatim,
  so B4 replaces it with a `fetch`.

Field mapping applied throughout, per Lane B's REQ-A-003 reply: `variant_gid` as
identity, snake_case, `cogs_source: 'none'`, `exclusionReasonFor()` as the single
implementation of R22, `stages[].fraction`, `running`/`paused` + `paused_reason`,
units derived from `order_days` rather than invented as a product column. Money
formatting now delegates to `lib/money.formatCents` — one implementation, so a
price in the UI cannot disagree with one in an email or a CSV.

### New UI states designed this sprint

`band_floored` renders **distinctly** ("Too quiet to judge", and the interval mark
is replaced by a sentence) — as Lane B asked, "there isn't enough data to check" is
not "we checked and it's fine". Plus: `assumption`-tier forecast with no fitted
range, profit-unknown forecast (breakeven undefined, profit columns blank),
`too_early` health, paused-by-external-change, reverted variants ("Put back"),
excluded variants inside a forecast, a guardrail whose profit metric cannot be
evaluated, and a selection where every product is excluded (422
`no_eligible_variants`).

### Bugs found and fixed in browser QA

- "Days below the expected range" counted **total** days but was compared against
  a *consecutive*-days limit, so a rollout that dipped twice and recovered showed a
  red stat while its health said "On track". Now reads the latest `breach_streak`
  and states the total separately.
- Two primary actions on the overview when two rollouts are live.
- A paused rollout wore healthy green on its "products on a new price" stat.
- A raw ISO date (`2026-07-29`) reached merchant copy via `next_decision_day`.
- The forecast card printed `confidence_explanation` twice and the breakeven
  sentence three times, because the engine's `explanation` opens with it.
- Status badge label clipped the catalog's last column.

### Open items for other lanes

`contracts/requests-lane-a.md` gained three:

- **REQ-A-005** — two copy fixes in strings Lane A renders verbatim: an ISO date
  inside `ruleConditionHolds`'s reason, and "revert everything automatically" in
  `defaultGuardrails()` where Lane A's builder says "put every price back
  automatically". Lane A is not working around either.
- **REQ-A-006** — **demo mode can never reach the `fitted` tier**, because
  `buildForecast` needs `elasticity_fits` and those need Supabase + Lane C's run.
  That is correct fallback behaviour (R32), but it hides an A3 deliverable and
  CP2's acceptance criterion. Lane A verified the fitted rendering by temporarily
  injecting a fit during QA and then reverting it — deliberately **not** from
  `generateDemoStore().truth`, which would be the ground-truth leak CLAUDE.md
  forbids. Seeding demo fits from a real C2 run would make CP2 demonstrable
  without credentials.
- REQ-A-004 (from A2) still open: cost-write action, and a server-side proposal
  draft to replace the `sessionStorage` hand-off, which still makes `/propose`
  client-rendered.

### For A4

The rollout page is on real readings, so A4 is the chart plus the kill switch.
`readings[]` is already the series *and* its band. Two things to honour: a day is
`below` only when it falls **outside** the interval, and `band_floored` days have
no honest band to draw. Lane B removed `recharts` at Lane A's request, so the
chart stays hand-authored SVG unless a request is filed.

A3 is "propose flow v2", and Lane B's B1 landed the real `ForecastResult`
contract mid-session, so A3 is **a migration plus a build**, not just a build.
Recording the mapping here so it isn't re-derived.

**What A3 delivers:** multi-SKU proposal (% or absolute), the forecast card
rendering `contracts/forecast_result.schema.json` — `breakeven.sentence` first,
`fitted` range with the band drawn, `confidence` + `confidence_explanation`,
`scenarios` as a collapsed "show your work" table, plus `assumptions`, `warnings`
and the per-`products` breakdown with `compare_at_action` and
`exclusion_reason` — and the guardrail builder emitting
`contracts/guardrails.schema.json` with its `sentence` persisted verbatim.

**The migration it requires.** `/propose` and `/products` share product identity,
so they move together, and `components/mock/engine.ts` shrinks to demo rollouts
and journal rows on top of Lane B's demo store (A4 and A6 retire those parts).

- `lib/engine/*`, `lib/demo/generator.ts`, `lib/contracts.ts`, `lib/types.ts` and
  `lib/money.ts` are **pure — no node imports** (checked), so a server component
  can import them. `lib/adapters/*`, `lib/db/*` and `lib/crypto.ts` are
  server-only; never import those into a client component.
- `generateDemoStore()` returns `ProductUpsert[]` / `OrderDayUpsert[]`, but
  `buildForecast()` wants full `Product[]` / `OrderDay[]` rows. Needs a small
  Lane A-owned hydrator (`components/demo/store.ts`) filling the row-only fields
  deterministically — keeps every page statically renderable, which the
  `DemoAdapter` would not.
- Field renames, from Lane B's REQ-A-003 reply: **snake_case throughout**;
  `id` → `variant_gid`; `priceCents` → `price_cents`; `cogsSource` `null` →
  `cogs_source: 'none'`; `kind` → three booleans, read via
  `exclusionReasonFor(product)` (the single implementation of R22, shared with
  the price writer); `units30d` is not on the row — derive from `order_days` or
  use `ForecastProductLine.baseline_units_per_day`; `stages[].sharePct: 25` →
  `stages[].fraction: 0.25`; rollout `'live' | 'holding'` → `'running'`, and
  `'paused_external'` → `'paused'` + `paused_reason`.
- **Reading verdicts and rollout health are now server-side** in
  `lib/engine/readings.ts` (`readingVerdict`, `readingSentence`, `rolloutHealth`,
  `healthSentence`) and back the evaluator, so the UI cannot show a verdict the
  machine did not act on. Two things A4 must honour: a day is `'below'` only when
  it falls **outside** the interval (not merely under the point estimate), and
  `band_floored: true` must render **distinctly** — "there isn't enough data to
  check" is not "we checked and it's fine".
- `GET /api/live` (specified in `contracts/api.md`, lands in B4) replaces
  `getLiveSummary()`; rollback and kill switch return
  `{ok, affected_skus, message}` and are idempotent. Only `/api/health` exists
  today — mock against `contracts/api.md`, not against guesses.
- A4 needs a chart. Lane B removed `recharts` at Lane A's request; hand-rolled
  inline SVG stays consistent with the zero-dependency stance and avoids a ~100 kB
  bundle on a page merchants open on phones. Decide at A4, and file a request if
  a library is wanted after all.

---

## Sprint A2 — done

### What landed

**The catalog is now a working tool** — `components/catalog/catalog-table.tsx`,
a client component fed by the server page:

- **Search** on title, variant and SKU, with `useDeferredValue` so typing stays
  responsive at 500 rows.
- **Filters**: product type, cost (has one / no cost yet), price (on a new price /
  unchanged). "Clear filters" appears only when something is filtered.
- **Sort** on every meaningful column, with `aria-sort` on the header and a
  direction that defaults sensibly per column type (names A→Z, numbers
  biggest-first). Products with **no cost sort last in both directions** — they
  are the rows to act on, not to bury at the bottom of a descending sort.
- **Multi-select** with a sticky action bar: count, the blended margin of the
  selection, a warning when part of the selection has no cost, Clear, and one
  primary action. Header checkbox selects all *matching* rows and goes
  indeterminate on a partial selection.
- **Inline cost editing** (`components/catalog/cost-cell.tsx`): click any cost,
  type, Enter to save / Esc to cancel, with saving and failed-to-save states and
  a toast that says what changed. Missing costs render an amber **Add cost**
  button rather than a blank — the state is an invitation, not an absence. Saving
  flips the source indicator to "Added by you".
- Subscriptions and gift cards **stay in the list**, greyed, checkbox disabled,
  reason on the row (R22). A product that silently vanishes from a catalog reads
  as a bug.

**Where the selection goes** — `/propose` (`components/catalog/propose-preview.tsx`).
Deliberately a **calculator, not a wizard**: pick % or an amount, up or down, and
it shows the breakeven sentence plus per-product new price, new profit and margin
before→after. Every number on it is margin arithmetic that holds regardless of
any model, and the page changes nothing. **The fitted forecast, the scenario
table, the guardrail builder and actually creating a rollout are A3** — so this
screen promises none of them and has no button that goes nowhere. It also
surfaces the compare-at policy (R13) ahead of time: when a new price would reach
or pass a crossed-out price, it says that price will be removed rather than show
a fake discount.

**A 500-SKU catalog to test against.** The mock now generates the catalog from a
fixed seed (never `Math.random`, so server render, hydration and build agree):
15 curated products the rollout/journal fixtures reference by id, plus 485
generated ones across 11 product types, ~7% deliberately without a cost. Verified
at 500 rows: no pagination, no virtualization, no page-level horizontal scroll,
typing stays smooth.

### For Lane B

`contracts/requests-lane-a.md` → **REQ-A-004**, three items, all mocked behind a
local seam so landing them is mechanical:

1. **A cost-write server action.** Lane A calls a mocked
   `saveProductCost(productId, cogsCents | null)` that already returns
   `{ok:true, cogsCents} | {ok:false, message}`. Integer cents; `null` must be
   allowed so a mistyped cost can go back to unknown; `message` is shown to the
   merchant verbatim; set `cogs_source='manual'`; **do not reject a cost above the
   price** — loss leaders are real, Lane A warns and saves.
2. **`productType` on `Product`** (Shopify product type) — drives the type filter.
3. **A server-side proposal draft** to replace the `sessionStorage` hand-off:
   `createProposalDraft(productIds) → {id}` / `getProposalDraft(id)`. Worth having
   before A3 builds the real propose flow on top of it.

### Known limitation, stated rather than hidden

The catalog→preview hand-off uses `sessionStorage`
(`components/catalog/selection.ts`), because 400 selected ids in a query string
is a 6 kB URL. Consequences: `/propose` is client-rendered, and a shared or
bookmarked `/propose` URL has no selection — which is why that screen has a
designed empty state pointing back at the catalog rather than an error. REQ-A-004
item 3 is the fix.

### Bugs found and fixed during A2 visual QA

- Sorting by cost or profit put "no cost yet" rows at the **top** in descending
  order, because the null ranking was inside the direction flip. Unknowns are now
  ranked outside it and stay last either way.
- The cost column jumped width when a cost went into edit mode, pushing the
  Status column out of view. Reserved a min-width on that column.
- The cost cell repeated the margin that the profit column already showed.
- Generated products collided on name, producing three visually identical rows
  after sorting — which reads as a rendering bug. The generator now re-draws and
  falls back to a model number.

### Verification

`npx tsc --noEmit` clean, `next build` green (7 routes, 14 static pages) in the
out-of-repo harness. Driven in a browser: search filters, type/cost/price filters,
sort direction toggles, select → sticky bar → preview hand-off, inline cost edit
saved by both Enter and the confirm button (the notice count drops and the row
leaves the "no cost yet" filter), and the increase *and* decrease breakeven
arithmetic checked by hand. Checked at 390px and 1440px, light and dark;
`document.documentElement.scrollWidth === window.innerWidth` at 390px.

---

## Sprint A1 — done

### The two things the other lanes need to know first

1. **There is no root project scaffold on `main`, and Lane A cannot create one.**
   At A1 start the repo contained only `PRD.md`, `BUILD_BRIEF.md`, `README.md`,
   `LICENSE` — no `package.json`, `tsconfig.json`, `next.config.*`,
   `postcss.config.*`. Those are Lane B-owned root configs. **`npm run build`
   therefore cannot run on `main` until Lane B lands them.** The exact four
   files, verbatim and version-pinned to what Lane A verified against, are in
   `contracts/requests-lane-a.md` → **REQ-A-001**. Landing them is a copy-paste;
   please do it in B1 if it isn't already done.

   Lane A did not ship an unverified sprint: `app/**` and `components/**` were
   copied into a throwaway Next 15.5 / React 19.2 / Tailwind 4.3 harness **outside
   the repo** (deliberately outside, so an untracked root `package.json` could
   never collide with Lane B's push) and verified there:
   - `npx tsc --noEmit` → clean
   - `next build` → green, 6 routes, 13 static pages, no type errors
   - every page opened in a browser at 1320px and 390px, light and dark

2. **A1 said "refactor v0's three pages onto the primitives" — there were no v0
   pages.** No `lib/`, no `app/`, no `components/` existed. Lane A therefore
   *authored* the three pages directly on the new primitives, which reaches the
   same end state A1 asks for. Consequence for scope: the pages are at v0 depth
   on purpose — search/filter/multi-select is A2, the propose flow is A3, the
   actual-vs-expected chart and kill switch are A4. See "Deliberately not built".

### What landed

**Design tokens** — `app/globals.css`. Tailwind v4 is CSS-first, so there is
**no `tailwind.config.js` and please don't add one** (it would split token
ownership across lanes). Structure: raw `--pf-*` values declared twice
(light / dark), then `@theme inline` maps them onto utility names.

- Consequence worth knowing: **no component writes a `dark:` variant.** They use
  semantic tokens (`bg-surface`, `text-ink-muted`, `border-border`) and are
  correct in both themes by construction. Dark follows the OS today;
  `[data-theme="light"|"dark"]` on `<html>` is already wired for the explicit
  toggle in A7.
- Status colour meanings are fixed app-wide and used nowhere else: **live** = a
  Priceflag price is on the storefront now · **hold** = waiting on purpose
  (scheduled, holding a step, paused) · **breach** = below the expected range or
  reverted · **accent** = an action or a link. Green never means "healthy"; it
  means "live".
- Type scale is dense-admin: `text-base` is **14px**, `text-md` is 16px and is
  what form controls use below `sm` so iOS Safari doesn't zoom on focus.

**Primitives** — `components/ui/*`, barrelled at `components/ui/index.ts`
(import from the barrel): `Button` / `ButtonLink` / `TextLink`, `Card` +
`CardHeader` / `CardBody` / `CardFooter` / `CardDivider`, `Table` + `THead` /
`TBody` / `TR` / `TH` / `TD` / `CellNote` / `TableEmptyRow`, `Badge` + `Tag`,
`Field` / `Input` / `SearchInput` / `Select` / `Checkbox`, `Modal`, `Toast`
(`ToastProvider` + `useToast`), `Skeleton` / `SkeletonText` / `SkeletonTable` /
`SkeletonCard`, `EmptyState`, plus `Notice`, `PageHeader`, `Stat` / `StatGroup` /
`DetailList` / `DetailRow`, and `components/ui/icons.tsx`.

**Zero runtime dependencies added, and Lane A intends to keep it that way.** No
`clsx`, no `tailwind-merge`, no `cva`, no `lucide-react`, no chart library, no
`next/font` network fetch. Class joining is a 6-line local helper
(`components/cn.ts`), icons are inline SVG, fonts are a system stack. If Lane A
ever needs a dependency it gets requested in `contracts/requests-lane-a.md`
first, never added to `package.json` directly.

**App shell** — `components/shell/*`. Permanent nav rail ≥`lg`, sticky bar +
drawer below it, skip link, one content column (`max-w-6xl`). The nav carries a
server-rendered **"what is live right now"** card on every screen, because that
is the product's core promise and therefore chrome, not content.

**Pages** — `app/page.tsx` (overview), `app/products/page.tsx`,
`app/rollouts/page.tsx`, `app/rollouts/[id]/page.tsx`, `app/journal/page.tsx`,
plus `loading.tsx` (root + rollout detail), `error.tsx`, `not-found.tsx`.

**Domain wording lives in one file** — `components/domain/status.tsx` holds every
merchant-facing sentence for rollout state: status labels, the change sentence,
the breakeven sentence, confidence tiers, the guardrail sentence, reading
verdicts. Single source so the app can't say "guardrail threshold" on one screen
and "abort condition" on another. **Lanes B and C: if you send an `explanation`
or a plain-language event `message`, Lane A renders it verbatim — so it has to be
plain language (R25). No "elasticity", no "confidence interval", no
"threshold breached".**

### The mock, and how to delete it

`components/mock/engine.ts` is the **only** file Lane A must delete when Lane B
lands `lib/`. It holds the engine types Lane A guessed at plus demo-store
fixtures (15 products, 6 rollouts covering all 7 statuses, 12 journal entries).
Pages import from it and only from it, so the swap is mechanical.

The guessed shapes are written up as a table for Lane B in
`contracts/requests-lane-a.md` → **REQ-A-003**, along with two behavioural asks:
a single store-wide "what is live right now" read, and rollback / kill-switch as
awaitable server actions returning `{ok, affectedSkus, message}`. **Lane A will
follow `contracts/` and `lib/types.ts` once they exist — the mock is a
placeholder, not a claim.**

Two notes on the fixtures, in case Lane B seeds from them: money is integer cents
everywhere (`components/format.ts` is the only file that divides by 100), and
`DEMO_TODAY` is pinned to `2026-07-29` so server and client renders always agree.

### Quality bar (PRD §6.5)

- **R25 plain language** — no statistics vocabulary in any merchant-facing
  string. "If daily orders fall more than 30% below what we expect for 2 days in
  a row, every price goes back automatically." The breakeven sentence is stated
  *before* any model output, because it is pure margin arithmetic and always
  true. Confidence tiers read "Based on your own sales" / "Based on limited
  history" / "Based on a general assumption", each with its one-line why.
- **R26 every state designed** — empty, loading, error, not-found, no-cost
  (`Profit unknown`, never a fabricated profit), thin-data (`assumption` tier),
  paused-by-external-edit, rolled-back, draft, scheduled. Every table has an
  empty row; every empty state links somewhere real. There are **no links to
  routes that don't exist yet** — no dead ends, and no UI advertising unbuilt
  features.
- **R27 accessible & responsive** — verified at 390px and 1320px, light and dark;
  keyboard-reachable skip link; modal traps focus, closes on Escape, restores
  focus; toasts are `aria-live="polite"`; the interval mark carries a text
  verdict badge so status colour never carries meaning alone. **The formal WCAG
  AA contrast audit is A7's deliverable and has not been run yet** — tokens were
  chosen to clear 4.5:1 but that is not the same as measured.
- **Glance test** — every screen answers "what is live right now, and how do I
  undo it": the nav's live card, the overview's live card, and the rollout page,
  where the undo *is* the single primary action whenever a Priceflag price is on
  the storefront. The confirm dialog names the product count and promises a
  journal row.

### Bugs found and fixed during A1 visual QA

Recorded because they are the kind of thing that silently returns:

- **Mobile horizontal overflow.** Grid/flex children default to
  `min-width: auto`, so a wide table pushed the whole page sideways instead of
  scrolling inside its own container. Fixed with `min-w-0` on `Card`, `CardBody`,
  the table scroll wrapper, and the page-level grid columns. Verified
  `document.documentElement.scrollWidth === window.innerWidth` at 390px.
- **`Table` forced `min-w-max` on every table**, which clipped a 4-column table
  inside a narrow card. Now a `layout` prop: `fit` (default, cells wrap) vs
  `intrinsic` (no wrap, scrolls sideways) for the wide data tables.
- **A paused rollout wore the calm green of a healthy one**, and showed a green
  "0 of 2". Card tone now derives from status (`rolloutCardTone`), and the tone
  of "products on a new price" follows the actual count.
- Badges wrapped mid-label in the narrow rail; `whitespace-nowrap shrink-0`.

### Deliberately not built in A1 (so nobody duplicates it)

Catalog search / filter / sort / multi-select and inline COGS editing → **A2**.
Propose flow, the full forecast card with the scenario table, the guardrail
builder → **A3**. The actual-vs-expected chart with its uncertainty band, the
store-level kill switch, richer breach states → **A4**; A1 renders the readings
as a shared-scale interval mark in a table instead
(`components/domain/expected-range.tsx`), following the repo dataviz conventions
so A4 can build on it rather than replace it. Connect-store and sync progress →
**A5**. Journal filters and CSV download → **A6**. The measured contrast /
keyboard audit → **A7**.

### For Lane B specifically

1. Land REQ-A-001's four root config files. Nothing else in Lane A is blocked,
   but `npm run build` on `main` is, until then.
2. `tsconfig.json` must keep `"paths": {"@/*": ["./*"]}` — every Lane A import
   uses it. If your scaffold differs (`src/` layout, different alias), land yours
   and note it in `docs/lane-status/lane-b.md`; Lane A will adapt next sprint
   rather than fight the scaffold.
3. Please don't add `tailwind.config.js`, and please don't edit `app/globals.css`
   (Lane A-owned) — tokens live there.
4. Confirm or correct the shapes in REQ-A-003 when `contracts/` lands.

### For Lane C

Lane A renders whatever confidence tier arrives and never blocks on a model:
`fitted` / `partial` / `assumption` each already have a badge, a colour, and a
plain-language fallback sentence. If you send `explanation` per
`forecast_result.schema.json`, Lane A prefers yours over its fallback — so write
it for a merchant, not for a statistician. `model_version` is rendered as a
traceability line under the forecast card (R31).
