# Shopify development-store evidence

> Copy this file outside the repository for each run. Store only redacted facts.
> Never record credentials, tokens, signed URLs, raw headers/payloads, production
> domains, customer PII, database connection details, or secret values.

## Run identity

| Field | Redacted value |
|---|---|
| Candidate commit SHA | `<full SHA>` |
| Deployment identifier | `<non-secret identifier>` |
| Development-store alias | `<alias, not domain>` |
| Operator | `<approved operator>` |
| Started at (UTC) | `<timestamp>` |
| Finished at (UTC) | `<timestamp>` |
| Overall result | `PASS / FAIL / ABORTED` |
| `auto_rollback` observed | `false` |

## Preflight

| Assertion | Result | Redacted evidence reference / note |
|---|---|---|
| Shopify identifies store as development | `PASS / FAIL` | `<reference>` |
| Catalog and orders are entirely synthetic | `PASS / FAIL` | `<reference>` |
| Candidate SHA matches deployment | `PASS / FAIL` | `<reference>` |
| Exact approved scopes present | `PASS / FAIL` | `<names only>` |
| Allowlist contains only test store | `PASS / FAIL` | `<yes/no; no domain>` |
| Credential-free journey harness passed | `PASS / FAIL` | `<local log reference>` |

## Journey evidence

| # | Step | Expected assertion | Observed result | UTC time | Redacted reference |
|---:|---|---|---|---|---|
| 1 | Install + OAuth callback | Installed; encrypted offline authority stored | `<result>` | `<time>` | `<reference>` |
| 2 | Background sync | Catalog and history complete | `<counts only>` | `<time>` | `<reference>` |
| 3 | Enter COGS | Manual cents read back with source `manual` | `<result>` | `<time>` | `<reference>` |
| 4 | Forecast | Shared engine returns valid forecast | `<tier/horizon/count>` | `<time>` | `<reference>` |
| 5 | Create draft | Baselines frozen; status `draft`; auto rollback false | `<result>` | `<time>` | `<reference>` |
| 6 | Confirm cohort zero | Only first cohort written and verified | `<counts only>` | `<time>` | `<reference>` |
| 7 | Order webhook | Aggregate applied once; replay deduplicated | `<deltas only>` | `<time>` | `<reference>` |
| 8 | External price edit | One external journal row; rollout paused | `<result>` | `<time>` | `<reference>` |
| 9 | No automatic overwrite | Priceflag write count unchanged | `<before/after counts>` | `<time>` | `<reference>` |
| 10 | Manual rollback | Frozen baselines restored and re-read | `<verified/failed counts>` | `<time>` | `<reference>` |
| 11 | Rollback retry | No additional Shopify write | `<before/after counts>` | `<time>` | `<reference>` |
| 12 | Uninstall | Active work stopped; authority removed | `<result>` | `<time>` | `<reference>` |
| 13 | Uninstall retry | Deduplicated; no new mutation | `<result>` | `<time>` | `<reference>` |

## Frozen-value verification

Use opaque local labels, never Shopify GIDs or SKUs.

| Variant alias | Frozen baseline cents | Before rollback cents | After rollback cents | Re-read verified | Merchant edit preserved |
|---|---:|---:|---:|---|---|
| `<variant-a>` | `<cents>` | `<cents>` | `<cents>` | `YES / NO` | `YES / NO` |

## Write and idempotency totals

| Operation | First attempt writes | Retry writes | Result |
|---|---:|---:|---|
| Confirm first cohort | `<count>` | `0` | `PASS / FAIL` |
| Order webhook | `<aggregate delta>` | `0` | `PASS / FAIL` |
| External edit handling | `0` | `0` | `PASS / FAIL` |
| Manual rollback | `<count>` | `0` | `PASS / FAIL` |
| Uninstall | `0` | `0` | `PASS / FAIL` |

## Failures and disposition

| Failure | Classification (`code/config/external`) | Safe state reached | Follow-up owner |
|---|---|---|---|
| `<none or redacted description>` | `<class>` | `<paused/cancelled/etc.>` | `<owner>` |

## Final attestation

- [ ] No production store was used.
- [ ] No credentials, signed URLs, raw payloads, or customer PII were retained.
- [ ] Automatic rollback remained disabled.
- [ ] Every Shopify write followed explicit merchant confirmation.
- [ ] External merchant edits were not overwritten automatically.
- [ ] Manual rollback was verified by re-reading Shopify.
- [ ] Uninstall removed stored write authority and stopped active work.
- [ ] No push, merge, deployment, or external configuration change was made as
      part of evidence collection without separate approval.

Operator sign-off: `<name / UTC timestamp>`
