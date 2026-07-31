# Cynthia

A live AI executive secretary. Cynthia answers a founder's business calls and texts, resolves routine requests from an approved knowledge base, and — when it can't safely answer — keeps the client on hold, asks the founder a focused question through their Ray-Ban Meta glasses, and relays the answer back. Every founder answer becomes a proposed knowledge entry, so the same question escalates once and not twice.

Requirements and the demo script live in [docs/PRD.md](docs/PRD.md). Architecture invariants and the rules this codebase is held to live in [CLAUDE.md](CLAUDE.md).

## Status

Early. The provider integrations are deliberately contract-only:

- **a1mobile** publishes no developer API. See [docs/architecture.md §2](docs/architecture.md).
- **Meta Wearables Device Access Toolkit** exposes no audio API at all, needs hardware plus an approved developer account, and cannot ship on iOS today. See [docs/meta-wearable-spike.md](docs/meta-wearable-spike.md).

Both are typed contracts marked `pending`, backed by deterministic simulators, and surfaced honestly in the integration-status panel. Nothing here pretends a simulator is a live integration.

Current progress: [docs/ROADMAP.md](docs/ROADMAP.md). Things only you can unblock: [docs/NEEDS-USER.md](docs/NEEDS-USER.md).

## Setup

Requires **Node ≥ 22.13** and **pnpm 11**. Node 24 is the current Active LTS and is the better choice for new machines; 22 is in maintenance.

```bash
brew install pnpm
```

```bash
pnpm install
```

## Working commands

```bash
pnpm run check
```

That is the one command CI runs: format check, lint, typecheck, then tests, failing fast. Individually:

| Command                 | What it does                       |
| ----------------------- | ---------------------------------- |
| `pnpm run format`       | Rewrite files to Prettier style    |
| `pnpm run format:check` | Fail if anything is unformatted    |
| `pnpm run lint`         | ESLint, zero warnings tolerated    |
| `pnpm run typecheck`    | `tsc --build` across every package |
| `pnpm run test`         | Vitest across all five projects    |
| `pnpm run coverage`     | Tests with a v8 coverage report    |

## Layout

```
apps/api          orchestrator and provider webhooks
apps/web          founder console (UI arrives in roadmap 6.1)
packages/domain   pure logic: state machine, policy gates. No I/O, no clock.
packages/adapters typed provider contracts and their simulators
tests/e2e         scenario gates (roadmap phase 7)
supabase/         migrations, RLS policies, seed data
docs/             PRD, architecture, spike, roadmap, decisions
```

`packages/domain` is kept pure by the linter, not by convention: importing `node:*`, touching `new Date()`, or calling `Math.random()` inside it is a lint error. The state machine has to be deterministic to be testable, so the guard is mechanical.

## Toolchain notes

**TypeScript is pinned to 6.0.3, not 7.x.** TypeScript 7 (the Go port) is out and much faster, but `typescript-eslint@8` declares a peer of `typescript >=4.8.4 <6.1.0` and aborts on TS 7, which would silently cost us all type-aware linting. Revisit when TS 7.1 ships the stable compiler API.

**Workspace packages resolve to source during development.** Each package exports a `cynthia:source` condition pointing at `src/`, so tests and typechecking read TypeScript directly with no build step, while plain Node gets the built `dist/`. Vitest is configured to discover tests only under `src/`, because a stale `dist/` copy passing while source is broken is worse than a slow run.
