---
name: daana-engineer
description: >
  General engineering advisor and dispatcher for the DaanaRx platform. Use FIRST
  for any non-trivial or ambiguous engineering ask ("build X", "add a feature",
  "fix this bug", "where do I start", "plan this", "how should I implement…",
  "what's the right way to…", "refactor", "which repo"). It decomposes the ask,
  routes to the right specialized skill (onboard, pre-commit gates, e2e, mass
  import), sequences work across the four repos (frontend, backend, mobile,
  inventory engine), enforces the codebase's best practices, and holds every
  inventory-touching change to the MASS MVP spec's non-negotiable rules. Does NOT
  replace the specialized skills — it decides which to invoke and in what order.
---

# DaanaRx engineering advisor & dispatcher

Use this to turn an engineering ask into a correct, minimal, convention-following
plan across the DaanaRx repos — and to delegate to the specialized skills instead
of reinventing them. Read the ask, produce: (1) which repo(s) change, (2) which
skill(s) to invoke and when, (3) an ordered plan, (4) the spec rules that apply.

## The repos (what changes where)

| Repo | Path | Stack | Role |
|---|---|---|---|
| **DaanarRX** | `/Users/rithik/Code/DaanarRX` | Next.js 15 / React | Frontend app. Reads the core **`items`** schema via `GET /inventory/items`. → `daanahealth/daana-rx` |
| **DaanaRx-Backend** | `/Users/rithik/Code/DaanaRx-Backend` | Express / TypeScript | Consolidated monolith (`daanahealth-gateway`): `/auth`, `/inventory/*`, `/transactions/*`, `/notifications`. Supabase service-role. → `daanahealth/DaanaRx-Backend` |
| **DaanaRx-Mobile** | `/Users/rithik/Code/DaanaRx-Mobile` | Expo / React Native | Mobile app; same REST client pattern (`EXPO_PUBLIC_API_URL`). Keep parity with frontend behavior. |
| **daana-inventory** | `/Users/rithik/Code/daana-inventory` | pnpm monorepo | Publishes `@daana-health/inventory-core` (generic engine: code templates, status state machine, validators), `@daana-health/domain-mass` (MASS medication schema, classification guide, DRX codes, labels), `@daana-health/inventory-react` (shared UI). Backend + frontend consume these. |

**Layering rule:** domain-agnostic logic (codes, status transitions, validators)
lives in `inventory-core`; MASS-specific rules (medication attribute schema,
specialty classification, label) live in `domain-mass`; the API wires them in
`DaanaRx-Backend`; UI in `DaanarRX`/mobile. Push logic DOWN to the lowest layer
that fits, then let consumers re-import. Changing a shared package means: rebuild
it, then the backend and frontend pick it up.

## Delegate map (invoke these — don't reinvent)

| The ask is about… | Invoke skill | Repo |
|---|---|---|
| "set me up", "run locally", "onboard", "new dev" | `daana-onboard` | all |
| "commit / push / ready" **backend** code, or finished a backend change | `daana-precommit-backend` | backend |
| "commit / push / ready" **frontend** code, or finished a frontend change | `daana-precommit-frontend` | frontend |
| reviewing/finishing **React** work (component, hook, state) | `react-doctor` | frontend |
| "e2e", "browser test the PR", "screenshots in the PR" | `daana-e2e-pr` | frontend |
| import / refresh / re-ingest **MASS clinic data** from a spreadsheet | `daanarx-mass-import` | backend + inventory |
| anything else (feature, bug, refactor, cross-repo) | **this skill's procedure** | depends |

If the ask cleanly matches a row, say so and invoke that skill rather than doing
it by hand. If it spans several, sequence them (below).

## Procedure for a general ask

1. **Classify**: setup · data import · feature · bugfix · refactor · review/commit
   · e2e. If it matches the delegate map, route there and stop.
2. **Locate the lowest layer**: does the logic belong in `inventory-core`
   (generic) or `domain-mass` (MASS-specific) rather than in the API/UI? Prefer
   the package; the API and UIs then consume it.
3. **Map the blast radius**: list every repo that must change. A schema/behavior
   change usually flows engine → backend route → frontend + mobile → tests.
4. **Order the work** (model → API → UI → tests → gate → PR):
   1. Change the package(s) in `daana-inventory`; rebuild; run inventory-core tests.
   2. Wire/extend the backend route(s); keep `/inventory/items` (core schema) as
      the source the app reads — do NOT add features onto legacy `units`.
   3. Update `DaanarRX` (and mirror in `DaanaRx-Mobile` for parity).
   4. Add/adjust tests at the layer you changed.
   5. Run the matching **pre-commit** skill (`daana-precommit-backend` /
      `-frontend`) before pushing — they are the quality gate, not optional.
   6. Open a PR on `main` (branch-protected: PR + 1 approval, CODEOWNERS
      `@rithik-g`, status check `build-and-test`). For frontend PRs, run
      `daana-e2e-pr` to attach screenshots.
5. **Apply the spec guardrails** for any inventory/checkout/auth change (below).
6. **Output**: a short plan — repos touched, skills to invoke (in order), the
   spec rules in play, and the smallest change that satisfies the ask. Implement
   the minimal version; don't gold-plate.

## Best-practice guardrails (codebase)

- **Canonical schema is `items` (core), not legacy `units`.** The app renders
  `GET /inventory/items`. New inventory work targets `items`/`item_types`/v2
  `locations`/`code_counters`. (`locations.id/code/specialty` are GENERATED from
  `location_id/name/temp`.)
- **`domain-mass` is the source of truth** for the MASS medication attribute
  schema, the `form` enum, the classification guide, and the `DRX-MASS-{LOCATION}-
  {counter:05d}` code template. Don't hardcode these in the API or UI — import them.
- **Keep frontend ↔ mobile parity**: both use the same REST client shape; a
  behavior change in one usually needs the other.
- **TypeScript strict**; no `any` escape hatches in new code. Match surrounding
  style; small, focused diffs.
- **Git flow**: branch off `main`, never commit/push without the user asking;
  every change lands via PR with the `build-and-test` check green and the
  pre-commit gate run locally first.
- **MCPs**: Supabase MCP for DB (this env can't DNS-resolve `*.supabase.co`
  directly); Render MCP for deploy/log/env inspection.

## MASS MVP spec — non-negotiables (apply to any inventory/checkout/auth change)

These are HARD requirements from the MASS MVP spec; never regress them. Full
distilled list in `references/mvp-guidelines.md`.

- **Unit-level + unique code**: each physical unit = exactly one record with a
  unique DRX code; codes are per-location sequential, zero-padded 5 digits, never
  reused.
- **Never hard-delete**: all removals/checkouts are soft state changes. Checkout:
  `Active → Checked Out`. Removal: `Active → Removed` with a required reason.
- **Every action logs a transaction** (check-in, check-out, edit, remove, cart
  approve/reject, expired-override). Edits record old/new value + user + timestamp.
- **Superadmin-gated checkout**: restricted users can add to cart but CANNOT
  complete checkout; every checkout needs superadmin approval. Non-negotiable.
- **FEFO order**: expiry asc → date received asc → lower DRX value. Search returns
  only `Active` by default; expired items are blocked from restricted checkout.
- **Status state machine**: Active · In Cart · Pending Approval · Checked Out ·
  Removed · Expired — one status per unit; honor searchable/visible rules.
- **Cart reservations** prevent double-checkout; carts clear after 24h inactivity
  and reserved items return to Active.
- **Auth**: 60-min inactivity timeout; password rules (≥10 chars, upper/lower/
  number/special). Expiry fallback for unknown dates = the domain validator's
  rule (10 years forward).

When an ask conflicts with one of these, flag it and propose a spec-compliant
alternative rather than silently implementing the non-compliant version.
