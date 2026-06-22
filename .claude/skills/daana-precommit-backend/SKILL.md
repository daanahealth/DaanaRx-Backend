---
name: daana-precommit-backend
description: >
  Pre-commit quality gate for the DaanaRx-Backend Express/TypeScript
  microservices. Run BEFORE committing or pushing backend code. Enforces: strict
  TypeScript typecheck clean across changed services + the consolidated build,
  the inventory-core engine unit tests green, a lint check, and a staged-diff
  best-practices review. Use when the user says "commit", "ready to push", "run
  pre-commit", "check my backend changes", or after finishing a backend
  feature/bugfix. react-doctor does NOT apply (no React here). Assumes the
  Supabase MCP is connected; will guide setup if it is not.
---

> 🧭 Routing / where-to-start / cross-repo work: see the **daana-engineer** skill — it decomposes the ask and delegates to the right skill.

# DaanaRx-Backend Pre-Commit Gate

This skill is the authoritative quality gate for **DaanaRx-Backend**
(`/Users/rithik/Code/DaanaRx-Backend`) — a **consolidated Express/TypeScript
monolith** (`consolidated/index.ts`, port 4000) that mounts the auth, inventory,
transaction, and notification routers directly under `/auth/*`, `/inventory/*`,
`/transactions/*`, `/notifications`. The router source still lives under
`services/{auth,inventory,transaction,notification}` (the old standalone layout,
ports 3001-3004) plus `gateway` and `bugs-dashboard`. All share the vendored
`@daana-health/inventory-core` schema package. CI builds the consolidated app
(`build:consolidated`) and runs the engine tests (`test:engine`).

**A commit must NOT proceed unless every gate below passes.** If any gate fails,
stop, report which gate failed with raw output, and do not commit.

> react-doctor is intentionally NOT part of this gate — the backend has no React.
> The React 90% gate lives in the frontend skill (`daana-precommit-frontend`).

## 0. Preflight

1. Confirm you are in the backend repo. The cwd or a parent must contain
   `package.json` with `"name": "daanarx-backend"`. If not, stop.
2. Confirm root deps installed (`node_modules`). If not, run
   `npm install --include=dev` (matches CI).
3. Identify staged files: `git diff --cached --name-only`. If nothing is staged,
   ask whether to gate the whole working tree or `git add` first.
4. Determine which services changed (path prefix `services/<name>/`,
   `gateway/`, or `consolidated/`). The typecheck gate targets those.
5. **MCP connectivity check (Supabase).** Services read/write Supabase
   (`cnjajswnqmzzhzoyadqa`) with the service-role key. If staged changes touch
   `services/**`, `migrations/`, `*.sql`, or any Supabase query code, verify the
   Supabase MCP is reachable via `mcp__supabase__list_tables`.
   - If unavailable, **pause and tell the user**:

     > The Supabase MCP isn't connected, so I can't validate schema/RLS or run
     > advisors against your DB changes. To connect: ensure
     > `/Users/rithik/Code/.mcp.json` has the `supabase` server (project_ref
     > `cnjajswnqmzzhzoyadqa`) and run `/mcp` to authenticate, then re-run.
     > Proceed with code-only gates for now?

   - If the diff doesn't touch DB/schema code, skip silently.

## 1. Deterministic gates (must all pass)

Run the bundled runner from the repo root:

```bash
bash .claude/skills/daana-precommit-backend/scripts/run-checks.sh
```

It executes, fails fast:

| Gate                | Command                                   | Pass criteria |
| ------------------- | ----------------------------------------- | ------------- |
| Typecheck (mono)    | `npm run build:consolidated` (`tsc`)      | exit 0        |
| Per-service typecheck | `tsc --noEmit` in each changed service  | exit 0        |
| Engine unit tests   | `npm run test:engine`                     | all pass      |
| Lint                | `npx eslint` if configured, else reported | exit 0 / N/A  |

Notes:
- `build:consolidated` (`tsconfig.consolidated.json`) is exactly what CI runs and
  type-checks the consolidated monolith with `strict: true`.
- The repo currently ships **no ESLint config**. The runner runs ESLint only if
  a config is present; otherwise it reports the type-strict `tsc` pass as the
  lint substitute and flags the missing linter as a best-practice gap (see §3).
- `test:engine` runs `node --test tests/engine.test.mjs` against
  `@daana-health/inventory-core`.

If the runner exits non-zero, surface the failing output verbatim and stop.

## 2. Best-practices review of the staged diff

Review `git diff --cached` against these backend conventions. Block on **bold**:

- **No secrets**: never commit `.env`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`,
  or any credential. They belong in env/Render config only.
- **Auth on protected routes**: new Express routes that read/write tenant data
  must verify the JWT and enforce `clinic_id` scoping (multi-clinic isolation).
  Flag any route missing auth middleware or missing clinic scoping — this is a
  data-isolation / RLS bypass risk.
- **Schema source of truth**: drug/lot/unit/transaction shapes and validation
  come from `@daana-health/inventory-core`, not re-declared per service. Flag
  duplicated/divergent schema definitions.
- **Strict typing**: no new `any`, no `// @ts-ignore`, no non-null `!` to dodge
  `strictNullChecks` without justification. tsconfig is fully strict — keep it.
- **Router registration**: new routers must be mounted in `consolidated/index.ts`
  under the correct public prefix (`/auth`, `/inventory`, `/transactions`,
  `/notifications`) and have CORS `ALLOWED_ORIGINS` handled. Flag a new route that
  exists only in a standalone service but isn't wired into the consolidated app.
- **Input validation**: validate request bodies/params before use; never trust
  client-supplied `clinic_id`/`user_id` — derive from the verified token.
- **Error handling**: async route handlers wrapped so errors return proper
  status codes, not unhandled promise rejections / leaked stack traces.
- Tests: new engine/business logic in `inventory-core` should add/update a case
  in `tests/engine.test.mjs`. Flag new untested logic.
- If DB-touching code changed and the Supabase MCP is connected, call
  `mcp__supabase__get_advisors` (security + performance) and surface new
  warnings (especially RLS / missing-policy advisories).

## 3. Verdict

Produce a short report:

```
DaanaRx-Backend pre-commit gate
  consolidated typecheck . PASS/FAIL
  per-service typecheck .. PASS/FAIL (services: ...)
  engine unit tests ...... PASS/FAIL
  lint ................... PASS / N/A (no ESLint config)
  best practices ......... PASS / N findings
  supabase advisors ...... clean / N new warnings | MCP not connected
```

- **All green** → tell the user the gate passed; commit if they asked (branch
  first if on `main`; end the commit message with the required Co-Authored-By
  trailer).
- **Any red** → "Commit blocked", list failing gate(s) and the path to green.
  Do not commit.

## Installing the automatic git hook (optional, recommended)

```bash
bash .claude/skills/daana-precommit-backend/scripts/install-hook.sh
```

The hook runs the deterministic gate (typecheck + engine tests + lint-if-present)
on every `git commit` and blocks on failure. The best-practices review is
Claude-driven — run this skill for the full gate before pushing.
