# Offline reasoning-resend analysis

## Snapshot-only budget replay

For budget comparisons, do **not** run the historical acquisition commands below when live-store
access is prohibited. `replay-budget.ts` reads only an explicitly supplied sanitized JSON array:

```json
[{ "route": "openai", "model": "gpt-example", "order": 0, "reported": 3000, "text_estimate": 150, "encrypted": true }]
```

Allowed fields only: `route`, `model` (route labels, not credentials), nonnegative integer
`order` (unique within a route/model trajectory), optional nonnegative `reported` and
`text_estimate` (the already-calibrated plaintext token estimate), and boolean `encrypted`.
No text, signatures, opaque transport, session identifiers, paths, or extra fields are accepted.
Omitted/zero reported counts use the estimate, then the fixed 1,000 charge for encrypted reasoning.
The newest step is exempt and charged. The tool compares a hypothetical rebuild at each trajectory
prefix with retaining the last 50 steps. These are selection checkpoints, not reconstructed actual
busts: the numeric format contains neither tags nor bust timestamps. Age 50 assumes one tag per step.
It does not discover or open databases, invoke hosts, or perform acquisition or migration.

```sh
bun packages/plugin/scripts/reasoning-resend-cost/replay-budget.ts /throwaway/root/sanitized-steps.json
bun test packages/plugin/scripts/reasoning-resend-cost/replay-budget.test.ts
```

`budget-synthetic.json` is deliberately synthetic test data, not a historical measurement.
Historical 10k-vs-age-50 route replay was **not run** for this change: the original numeric outputs
were removed and acquiring them from live stores is prohibited. A separately authorized operator
can supply the sanitized trajectories for the routes in the design table. The fixed 10,000
default does not depend on that informational comparison.

No product code and no model requests. Run from the repository root with the
installed Bun/SQLite/Python tools. The requested calibration file lives at
`src/hooks/magic-context/tokenizer-calibration.ts`, not `src/features/…` at this
revision; no compatibility file is needed.

```sh
timeout 20s df -h /System/Volumes/Data
timeout 120s python3 packages/plugin/scripts/reasoning-resend-cost/copy-pi.py
timeout 1800s bun packages/plugin/scripts/reasoning-resend-cost/analyze.ts \
  "${TMPDIR%/}/magic-context/reasoning-diff" \
  2026-09-27T00:00:00Z 2026-10-04T23:59:59.999Z
timeout 120s bun test packages/plugin/scripts/reasoning-resend-cost/analysis.test.ts
timeout 300s bun run --cwd packages/plugin typecheck
timeout 120s python3 packages/plugin/scripts/reasoning-resend-cost/verify-report.py \
  "${TMPDIR%/}/magic-context/reasoning-diff" docs/reports/reasoning-resend-cost.md
```

Use a background execution facility with a long timeout for analysis, not a
foreground polling loop. **Do not copy/vacuum the whole OpenCode store**: it can
fill the shared disk. The task's corrected acquisition method permits narrow
read-only SQL on live `message`/`part` (v2: `session_message`). The script opens
named OpenCode stores with Bun SQLite's `readonly: true` and a read transaction;
selects only windowed message IDs, session IDs, timestamps, route IDs and usage;
then selects tokenization fields of parts **only for candidate pairs**. It never
queries `credential`, `account`, `account_state` or `control_account`. Replay
payloads are measured by length, not retrieved. Text needed by MC's tokenizer
stays in memory and is never written to scratch. SQLite schema names only identify
the store generation. This is a single-read-transaction view per OpenCode store,
not a simultaneous cross-harness snapshot.

Pi acquisition refuses an existing root and more than 2 GB of selected files.
Files are copied before reading; file metadata selects recently modified sessions.
Analysis refuses Pi symlinks escaping the temporary root. Check disk free space
before acquisition; numeric output is small and no OpenCode DB copy is created.

`summary.json` and `pairs.jsonl` under the temporary root contain numeric counts
and step/session identifiers, **not** text, tool arguments, signatures or opaque
payloads. Do not commit raw transcripts or databases. After writing the report,
remove the entire temporary directory, including numeric outputs:

```sh
timeout 120s rm -rf "${TMPDIR%/}/magic-context/reasoning-diff"
```

## Estimator

- Consecutive assistants within a session, including assistants with errors or
  missing usage as boundaries (never bridge them). Pi follows `parentId`, not
  adjacency in an append-only file; compaction/context-edit/custom-message/model
  changes between steps invalidate a pair.
- Logical input is `input + cache.read + cache.write`. **OpenCode's stored output
  excludes separately reported reasoning; Pi's output includes it** on these measured routes. Thus
  subtract O in OpenCode, and O-R in Pi. The literal brief formula is included as
  a diagnostic on the same reported-reasoning observations: it adds one to k in
  OpenCode and is not a second measurement of replay. Default cache-prefix
  tolerance is 128 tokens; results also expose 0 and 512. This is a necessary
  screening proxy, not proof of complete byte identity.
- OpenCode 1 tool results come from step N's tool parts. User text between steps
  and Pi `toolResult` entries are new content. Tool **arguments** are output of N,
  not new content; independently tokenize them only on the text-fallback routes.
- Text is counted by MC's actual `estimateTokens` (ai-tokenizer **Claude** BPE),
  multiplied by `resolveModelCalibration(provider, model).proseRatio`. The static
  `toolsRatio` is for **tool definitions**, not result bodies. No residual/session
  scalar is inferred from the same input delta being fitted.
- Guess 12 tokens per tool-result wrapper and 8 per user wrapper. The intercept
  absorbs fixed wrapper/serialization mismatch. Tool-call generation versus
  replay tokenization can still differ. Images/files, unfinished tools, and new
  bodies over 100,000 characters are excluded before expensive BPE.
- Primary fit: positive reasoning, new body <=512 tokens, prefix gap <=128.
  Do **not** remove negative residuals or outliers just because they disagree.
  Also fit body <=128/2048, no-tool, new-user/no-user subsets and exact/looser
  prefixes. A model with fewer than three varying observations has no slope.
- Where reported reasoning is absent/zero but reasoning text exists, fit against
  calibrated stored text and subtract independently tokenized visible output.
  Never equate empty OpenAI summaries with zero encrypted reasoning.
- OLS `resent = k * reasoning + c`; uncertainty is a session-cluster sandwich
  normal-approximation 95% interval, **not** reliable with very few sessions.
  Spread also includes p10/p50/p90 per-pair `resent/reasoning` for reasoning >=64.
  Fits with a lag covariate test `k*latest + h*previous + c`; `h≈-k` would suggest
  replacing the previous block. Conditioning on intact caches can exclude exactly
  such replacements, so lag fits cannot prove history policy by themselves.
- Error sensitivity reports both a uniform 20% body-count perturbation and an
  adversarial per-pair ±20% body plus ±all guessed wrappers perturbation of k.
  These are scenarios, not measured error bars. Text-fallback output/reasoning
  counts have additional correlated uncertainty.

The script fails on unimplemented OpenCode 2 assistant shapes rather than silently
treating a v2 store as v1. See the report for the inventory and unsettled routes.
