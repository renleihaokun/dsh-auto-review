# Desktop branch — DeepSeek Harness `0.2.0-rc.2`

> 中文版：[docs/desktop-port.zh.md](desktop-port.zh.md)

This is the **`desktop` branch of a fork** of [PerryLink/dsh-auto-review](https://github.com/PerryLink/dsh-auto-review). It ports the plugin to the DeepSeek Harness **desktop runtime `0.2.0-rc.2`** — which is what `@deepseek-ai/dsh` publishes as `latest` — and fixes several defects found while doing so. Upstream `main` targets the `0.2.1-alpha.1` line instead.

Everything below is written against this branch. For the plugin's own design and configuration schema, read the upstream READMEs; this document only covers what the branch changes.

---

## 1. Do not install this from npm

`npm i dsh-auto-review` gives you **upstream `0.12.17`**, whose `dependencies` pull the `0.2.1-alpha.1` harness tree. Installing that into a `0.2.0-rc.2` profile **hoists the mismatched tree into the profile's own `node_modules`**, and `dsh-app-boot` resolves the profile's `node_modules` first — so the host that boots is not the host that was installed. The observed result is a boot crash.

This branch removes that failure mode rather than pinning around it: **no `@deepseek-ai/*` package is a runtime dependency any more** (see §3.2). `test/desktop-port.spec.ts` fails the suite if one is ever added back.

---

## 2. Install

### Option A — vendor + `link:` (what this branch was developed and verified against)

```powershell
$plugins = "$env:USERPROFILE\.dsh\profiles\desktop\plugins"
git clone --branch desktop https://github.com/renleihaokun/dsh-auto-review.git "$plugins\dsh-auto-review"
cd "$plugins\dsh-auto-review"
pnpm install --ignore-scripts
pnpm run build
```

Then in `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": { "dsh-auto-review": "link:./plugins/dsh-auto-review" },
  "dsh": { "profile": { "bundles": ["dsh-auto-review"] } }
}
```

A `link:` install **does not install the linked package's dependencies**, which is exactly why it cannot shadow the profile's runtime. The prebuilt `lib/` you produced with `pnpm run build` is what the profile loads.

### Option B — `dsh` plugin CLI, git channel

```powershell
dsh plugin --profile desktop add github:renleihaokun/dsh-auto-review#desktop
```

> **Not verified on this branch.** The git channel installs dependencies and runs the package's `prepare` script in an isolated environment, which is the code path that produces the hoisting described in §1. On this branch there are no `@deepseek-ai/*` runtime dependencies left to hoist, so the mechanism is gone — but option A is the configuration with live evidence behind it (§5).

### Option C — tarball

```powershell
pnpm pack
dsh plugin --profile desktop add .\dsh-auto-review-0.12.17-desktop.1.tgz
```

### Required profile patch — the permission preset

The answerer engages only while the session's **permission preset is `review`**. That preset must exist in the profile, and the plugin deliberately does **not** ship it enabled, because the patch row for `permission` **replaces the whole `permission` config** — a profile that already customises its presets would end up with two rows for one id.

Add this to your **profile** patch layer (`~/.dsh/profiles/desktop/cordis.patch.yml`), restating every preset you want to keep:

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
      review: { sandbox: workspace-write, approval: ask }
```

Then pick **AI 审查 / review** in the permission dropdown, or run `/permission review` in a running session. Without it the plugin is mounted but inert — fail-closed, never fail-open.

The plugin's own shipped `cordis.patch.yml` carries the same block commented out, next to the near-identical optional `invariant` row.

### Windows + pnpm note (build/test only)

`pnpm install` with pnpm's default **isolated** `node_modules` layout creates Windows **junctions**, and two things then break — both outside this plugin:

1. **TypeScript 7's native compiler cannot locate itself.** `typescript`'s `lib/tsc.js` resolves its platform package with `import.meta.resolve("@typescript/typescript-win32-x64/package.json")`; launched through a junction, Node keeps the junction path and the upward `node_modules` walk never reaches `.pnpm/typescript@…/node_modules`, so it throws *"Unable to resolve @typescript/typescript-win32-x64"*.
2. **Vite/vitest cannot resolve some of its own dependencies** — same mechanism: a module loaded through the junction path does not find a dependency that only exists under `.pnpm/`.

Neither is caused by this branch, and neither affects Linux CI. The workaround used here is a **hoisted** layout, which is also what an `npm install` produces:

```powershell
pnpm install --ignore-scripts --config.node-linker=hoisted
```

`--ignore-scripts` skips the `node-pty` / `koffi` native postinstalls; they are only needed by the `eval` face, not by `typecheck`, `test`, or `build`.

---

## 3. What changed

### 3.1 Source changes — the port itself

Upstream ships `src/**` in the published tarball, but the artifacts the plugin actually loads are the **bundles** in `lib/`. Those bundles are not tracked by git, and the initial port had been applied **directly to `lib/index.js`**. This branch re-expresses every one of those patches in TypeScript, where it can be reviewed, typechecked, and tested.

Eight source files:

| File | Change |
|---|---|
| `src/runtime.ts` | `PRESET_GATE`; the permission-preset gate (`presetGateState`, `effectiveEnabled`); the `/auto-review on` refusal; the live panel view (`livePanelView`, `sessionById`); the process-lifetime tally (`MemoryTally`, `tallies`, `tallyFor`, `MEMORY_RECENT_CAP`) and its updates in the verdict/rejection/fallback paths. |
| `src/review.ts` | `redactInlineSecrets` (F3a) and its wiring into `sanitizeArguments` (F3b) and the transcript line `contextLine` (F3c); the TRUNCATED disclosure in `renderCallContext` (F4a); the matching deny rule in `buildReviewPrompt` (F4b). |
| `src/projection.ts` | `sessionId` in the persisted state schema, `initAutoReviewProjection(enabledByDefault, sessionId)`, the optional `liveView` wire view, and `stateVersion: 4`. |
| `src/projection-types.ts` | `AutoReviewProjectionState.sessionId` — the companion type the bundle-level patch could not carry. |
| `src/messages.ts` | The `presetGated` message in `en` and `zh`, and the corrected `description` in both. |
| `src/index.ts` | Re-exports `PRESET_GATE`. |
| `src/cache.ts`, `src/config.ts` | Wording: the reviewer is not a second model (§3.3). |
| `test/*` | `projection.spec.ts` and `command.spec.ts` follow the v4 contract and the corrected wording; `desktop-port.spec.ts` is new. |

`src/eval/**` is deliberately **not** touched: its "second-model review" is a different, genuinely second-model feature of the `dsh-eval` engine (`--review-model`).

### 3.2 Configuration and metadata

- **`dependencies` holds only `tsdown`, `typescript`, `yaml`, `zod`.** The fourteen `@deepseek-ai/dsh-*` packages upstream keeps there (so the shipped `dsh-eval` face works out of the box) moved to `devDependencies`. Consequence, stated plainly: **the `dsh-eval` / `./eval` face is not installed for consumers of this branch.** That is the price of removing the boot-crash mechanism instead of pinning around it. `tsdown`/`typescript`/`zod`/`yaml` stay because the git channel's isolated `prepare` environment has no devDependencies.
- **`peerDependencies`** collapse from six `||`-unioned bands to `>=0.2.0-rc.2 <0.3.0`, with `@deepseek-ai/cordis ^4.0.4` and `@deepseek-ai/schemastery ^3.18.4`. `engines.dsh` matches. Claiming the `0.1.x` lines on a branch that was only tested against `0.2.0-rc.2` would be a promise without evidence.
- **`@deepseek-ai/dsh-api-remotes`** joined `dsh.client.inject` (replacing `@deepseek-ai/dsh-client-ui-slots`, whose types `src/client/index.ts` still augments) and is declared as an **optional peer** — every other name in that inject list already was one.
- **`pnpm-workspace.yaml`** pins the whole `@deepseek-ai/dsh-*` graph to `0.2.0-rc.2`. This graph is build/test only; nothing in it reaches a consumer profile.
- **`cordis.patch.yml`** uses the row id `perrylink-auto-review` (the desktop profile's built-in experimental auto-review bundle already inserts `id: auto-review`, and two inserts must not share an id), covers **both** `bash` and `pwsh` in `toolsPolicy.overrides` so one patch works on either shell, and sets `reviewerProvider: spawn` and `fallbackPolicy: delegate`.
- `version` is `0.12.17-desktop.1`, and `package.json#desktopBranch` records the provenance.

### 3.3 Deliberate divergences from upstream

1. **"Second model" → "same-model independent".** The reviewer runs on `spawn`: a fresh child that inherits **none** of the requesting session's turns. It is the same model reading the evidence independently. Upstream's schema default is `fork`, which seeds the reviewer from the very turns it is judging — this branch sets `spawn` in the shipped patch.
2. **The `/auto-review on` refusal is localized.** The bundle-level patch hardcoded its Chinese string at the call site. It now lives in the `en`/`zh` message table (`presetGated`); the Chinese output is byte-identical, and English users get English instead of Chinese.
3. **The `<n>` in the TRUNCATED disclosure and the prompt's deny rule are new** — the bundle-level patch had the disclosure but not the rule, and the rule is what makes the disclosure actionable.
4. Cosmetic: `PRESET_GATE` moved from the bundle prelude into `src/runtime.ts`; the magic `10` became `MEMORY_RECENT_CAP`; several doc comments were corrected where the port had made them false (`buildContextSection` claimed tool-call arguments enter the transcript verbatim — after F3c they do not).

---

## 4. The defects fixed

All four were found by reviewing the port, and each is reproducible from the tests in `test/desktop-port.spec.ts`.

### F1 — a preset read failure re-opened a closed gate (fail-**open**)

`presetGateState` returned `{ mounted: false, on: false }` when the permission-preset service threw. `effectiveEnabled` treats `mounted: false` as "this profile has no presets" and falls through to the sticky session override — so a stale in-memory `true`, or a durable `autoReview/state { enabled: true }` in the log, kept the answerer **claiming requests after the preset became unreadable**. A read failure now reports `{ mounted: true, on: false }` and the gate stays shut. The two states are deliberately not collapsed; the code says why.

### F2 — `/auto-review on` wrote an override the answerer ignores

While the gate preset was not selected, the command still appended a durable `autoReview/state { enabled: true }`. The answerer ignored it (the preset outranks the switch), but the command read it back on every later call and answered *"already ON"* for the rest of the session. It now refuses and names the remedy (`/permission review`), and writes nothing.

### F3 — secrets inside a free-form string argument reached the reviewer verbatim

The key-based pass inspects object **keys** only, so a shell command line was invisible to it:

```
deploy --token sk-live-123            →  deploy --token [REDACTED]
--api-key=ak-9                         →  --api-key=[REDACTED]
API_SECRET="s3cr3t"                    →  API_SECRET="[REDACTED]"
curl -H "Authorization: Bearer tok-42" →  curl -H "Authorization: Bearer [REDACTED]"
```

Both rendering paths are covered: `sanitizeArguments` for the pending call's own preview, and `contextLine` for the compact transcript — the transcript was the path that reached the reviewer with the secret intact. **Known limit, pinned by a test:** a bare secret with no key adjacent to it (`echo sk-live-123`) stays visible. This is a heuristic, not a secret scanner.

### F4 — truncated evidence read as complete evidence

The pending call's preview is cut at `reasonMaxChars` (default 2000) behind a bare `…`. A reviewer shown only the benign head of a long call could allow it, with the decisive arguments cut off. A truncated preview is now labelled and counted:

```
Tool call arguments (sensitive values redacted, TRUNCATED):
…
[TRUNCATED EVIDENCE: only the first 2000 of 5496 characters are shown; the remainder is
NOT visible to you. An action you cannot see in full is insufficient evidence — the verdict
rules require DENY on insufficient evidence. Deny unless the visible part alone proves the
action safe.]
```

and the verdict rules gained `- truncated evidence counts as insufficient: when the arguments are marked TRUNCATED, DENY.`

### Also fixed — the review panel showed all zeros

The `autoReview` panel projection folds the plugin's own `autoReview/*` session events. On a host that refuses unmarked unknown event types — `auditMayAppend()` false, which the `0.2.0-rc.2` line is — **none of those events is ever written**, so the panel folded an empty log. The persisted state now carries the owning `sessionId` (state version 4) and the runtime substitutes a live wire view that serves the switch state and the session's real activity from the in-memory mirror. On a marker-aware host the pure fold stays authoritative and is returned untouched.

---

## 5. Verification

### The repository's own gate

| Check | Result |
|---|---|
| `pnpm run typecheck` (`tsconfig.json` + `tsconfig.test.json`) | **pass** |
| `pnpm test` | **27 files / 318 tests pass** |
| `pnpm run build` | **pass** — `lib/index.js`, `lib/invariant.js`, `lib/client.js`, `lib/eval*.js`, `lib/types/**` |
| `pnpm run verify:self-contained` | **pass** (`all dependency specs resolve from the registry`) |
| `pnpm run check:lockfile` | **pass** (`package.json and pnpm-lock.yaml agree`) |
| `pnpm run check:readmes` | **pass** (5 READMEs, 24 sections, 23 config keys) |

`test/desktop-port.spec.ts` adds 15 cases: inline-secret redaction on both paths, the documented bare-secret limit, the TRUNCATED disclosure and its negative, the prompt rule, five preset-gate cases (gate open, preset outranks `enableByDefault`, **fail-closed on a failing read**, the `/auto-review on` refusal, and the no-preset-service fallback), and three dependency-policy cases.

### Source ≡ verified artifact

The load-bearing question for a re-port is whether the source really reproduces the behavior that was verified. It was answered by building the branch and comparing the result with the bundle that had been verified live.

The build output carries `//#region` banners naming the originating module, so every hunk can be attributed to a source file. Normalizing the pnpm-isolated path prefix inside those banners (the only difference a hoisted layout makes) gives a line-for-line comparison:

- **vs. the published `0.12.17` tarball:** 40 hunks, +264/−22, across 6 source files, **zero hunks inside the inlined `zod`**.
- **vs. the live-verified bundle:** 22 hunks, +142/−74. Every one was audited: documentation expansion, cosmetic formatting (multi-line object literals, `sessionId`'s position in the schema), `PRESET_GATE`'s relocation and export, the `MEMORY_RECENT_CAP` constant, the semantically identical `init` spelling, and the intentional localization of the gate refusal (whose Chinese text is byte-identical). **No behavioral difference was found that was not intended.**

### Live evidence (gathered on the bundle-level port, which the comparison above proves this source reproduces)

On the reference `0.2.0-rc.2` desktop profile, with `review` selected:

- More than ten escalations were answered by the reviewer: `allowed-once` with a specific reason in every case except the rejections.
- Two genuine rejections, both for the right reason: an argument preview exceeding the cap was refused citing the TRUNCATED marker ("*truncated evidence is insufficient evidence*"), while a complete, small, trivially reversible write was allowed with the reason explicitly noting that its arguments were **not** truncated. The gate discriminates rather than rubber-stamping.
- The panel was confirmed against a real session: true switch state, true cumulative counts (allows / denies), four recent verdicts, and a working approve-retry.
- The transcript redaction (F3c) was read back out of a real reviewer child's prompt: the earlier 5496-character call renders as `--token [REDACTED]`, and the fake token appears **nowhere** in the prompt.
- Session-log hygiene held: **zero** real `autoReview/*` events were written to the session log, which is the documented degradation on this host line.
- A 13-check rollback/verification script over the profile passed 13/13.

---

## 6. Known limitations

- **The risk valve is inert.** `riskPolicy.maxAutoAllow` is `'high'` and `riskLevel` is optional in the verdict schema, so `riskExceeds` can never be true. Not changed here; the config surface is upstream's.
- **The reviewer preview is capped at 2000 characters** (`reasonMaxChars`). F4 now makes truncation visible and deniable, but the cap itself is unchanged.
- **Tool-result text in the transcript is not redacted** (only tool-call arguments are). Results are already-presented content and redacting them wholesale would damage the evidence the verdict depends on.
- **The review is not model-diverse.** `spawn` removes the shared context, not the shared model: a reviewer on the same route shares the requester's blind spots. Configure `reviewerModel` to route it elsewhere.
- **The panel's per-session tally is in-memory** and resets when the harness restarts. On a host whose audit envelope works, the durable fold is authoritative instead.
- **The `eval` face is not installed for consumers** (§3.2). Install it from `devDependencies` if you need `dsh-eval`.
- **Windows + pnpm's isolated layout** needs the hoisted workaround for `typecheck`/`test` (§2).

---

## 7. Upgrading, and the license

The branch tracks exactly one runtime line. When `@deepseek-ai/dsh` moves, the pins to bump are `engines.dsh`, the `peerDependencies` band, `devDependencies`, and the `overrides` map in `pnpm-workspace.yaml` — then re-run the gate in §5. The five-language READMEs are upstream's and describe upstream's compatibility; `package.json#desktopBranch` and this document are the branch's source of truth.

Upstream is Apache-2.0. This branch keeps the `LICENSE` and the original `author` field unchanged, records itself under `contributors`, and states its changes here and in `CHANGELOG.md`, as the license requires. It is **not** affiliated with or endorsed by PerryLink; the badges and links in the READMEs still point at the upstream project, which is where the plugin's documentation, issue tracker and releases live.
