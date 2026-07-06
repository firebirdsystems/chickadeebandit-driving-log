# Driving Practice Log

A learner's-permit practice log for the Chickadee Bandit family tier. Most US states
require 40–60 supervised hours before a road test; this app records each supervised
drive, has a parent **countersign** it, tracks progress toward the state requirement,
and exports a clean summary for the DMV.

## Why two protocols

The value proposition is a **tamper-evident** record, so the security-sensitive tables
are never written by browser SQL:

| Table | Mechanism | Policy | Why |
|---|---|---|---|
| `drives` | **`append_only_records`** | `endpoint_only` | Each logged drive is immutable — it can't be silently edited or deleted after the fact. Ids, writer, and timestamps are server-derived. |
| `certifications` | **`agreements`** | `endpoint_only` | Driver attests the entry is accurate; the supervising parent countersigns. `api/agree` maps each caller to *their own* flag, so neither party can forge the other's signature. A drive is certified once both agree (`status = 'locked'`). |
| `notes` | **`append_only_records`** (adult-only) | `endpoint_only` | Immutable supervisor observations, and corrections: an adult appends a `void` note to exclude a mistaken entry from totals **without erasing history**. |
| `goals` | — | `owner_only` | Each teen's state-hour goal; adults may set it on their behalf. |

Because `drives` is append-only, there is no "edit" — a wrong entry is **voided** (adult)
and re-logged. That is the correct behavior for a legal log: history is annotated, never
rewritten.

## Progress

Certified progress = total (and night) minutes of drives whose certification is `locked`
and that have **not** been voided, measured against the driver's `goals` row (defaults:
50h total / 10h night).

## Quick start

```bash
npm run dev     # preview at http://localhost:3001
npm run build   # produce dist/bundle.json
npm test        # run manifest + logic tests
```
