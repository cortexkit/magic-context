# Long-turn context pressure: live OpenCode 2 / DeepSeek (issue 886)

Manual diagnostic, not a CI scenario or a product change. It starts a **real
OpenCode 2.2.6 `serve --service`**, using the e2e launcher's isolation, activation,
schema guard, process-group cleanup and open-file checks. It loads this checkout's
`packages/plugin` package, whose OpenCode 2 entry is `dist/v2/server.js`.
This harness opts into the launcher's bounded transport-readiness wait: service
registration can precede the first successful `/api/plugin` response. Only an
initial 503 is retried, for at most 30 seconds, with a line logged for every retry.
No session or model request is retried by that wait; other errors fail immediately.

## Run on this Mac

From the repository root, install workspace dependencies and build the plugin:

```sh
bun install --frozen-lockfile
bun run build
# Set DEEPSEEK_API_KEY in your environment through your usual secret manager.
# Never put the key on the command line or enable shell tracing.
nice -n 10 bun packages/e2e-tests/live-886/run.ts
```

The first run **installs `@opencode/cli@2.2.6` and `@opencode/ai@2.2.6`** into
the run's private root with the existing `ensureSharedOpenCode2` e2e installer.
Even installer `--version` probes have the isolated environment. If that exact
host/schema pair cannot be fetched, it tries published stable 2.2.x releases,
newest first; it never silently substitutes 2.1.x. Network is needed for npm on
first install. It prints the actual host version in the summary.

To reuse a previous throwaway install instead of downloading it again:

```sh
nice -n 10 bun packages/e2e-tests/live-886/run.ts \
  --cli '<previous-run>/cli/2.2.6/node_modules/@opencode/cli/bin/opencode.exe' \
  --ai-root '<previous-run>/ai/2.2.6'
```

`--ai-root` must contain `node_modules/@opencode/ai` matching the binary exactly.
No OpenCode command, including version checks, runs with the default environment.

Defaults (all numeric options accept overrides):

```sh
nice -n 10 bun packages/e2e-tests/live-886/run.ts \
  --step-cap 400 --dollar-cap 8 --batch-steps 220 --batch-count 4 --timeout-minutes 120 \
  --input-limit 302222 --context-limit 1000000 --output-limit 32768 \
  --threshold-tokens 250000 --mcp-every 0 --mcp-tools 2
```

`--threshold-tokens` sets Magic Context's `execute_threshold_tokens.default`. A fresh
session grows by roughly 700 tokens per step, so the reporter's 250K needs far more steps
than the default caps allow. A lower threshold reaches the near-limit state cheaply.
`--mcp-every N` also toggles the MCP server every N head steps after step 6, so Code Mode
catalog and MCP-guidance rows keep accumulating through the run. `--mcp-tools N` makes the
server list N tools with longer descriptions, so each catalog row is closer to a real server's
size (about 40 tools gives rows of a few thousand tokens).

The provider is `deepseek`, base URL `https://api.deepseek.com`, model
`deepseek-flash`. The secret is read from `DEEPSEEK_API_KEY` only and written only
to the run's owner-only `work/opencode.json`. It is not inherited by the host as
an environment variable, passed in argv, printed, or copied into evidence.
The top-level run directory is private. Treat the whole directory as sensitive.

Magic Context config sets only the reporter's `execute_threshold_tokens.default:
250000`, `execute_threshold_percentage: 80`, `protected_tokens: 16000`,
`history_budget_percentage: 0.1`, and historian `deepseek/deepseek-flash`.
Other MC settings retain product defaults, not the e2e mock defaults. Only the
DeepSeek host provider is enabled; tool permission is allowed in the disposable
workspace so shell calls need no interactive bridge.

**Geometry caveat:** the issue states input 302,222 but not context/output.
The newest comment reports a local wire-pressure estimate of 60,101 input tokens
displayed as 6.2% of the usable window. Context 1,000,000 and output 32,768 follow:
60,101 / (1,000,000 − 32,768) = 6.21%, matching that reported 6.2%. These values
are a reconstruction, not values supplied by the reporter. Change the flags if
the exact model metadata becomes available.

## Workload and limits

The driver seeds `PLAYBOOK.md` and `AGENTS.md`, sends one user prompt over OpenCode's own HTTP
client, and waits for idle with `session.wait`. The prompt asks for a multi-file
TypeScript arithmetic CLI, using only shell heredocs, builds/tests after changes,
source readbacks with `cat`/`sed -n`, and failure repairs. It explicitly requires
a playbook reread before acting. It targets 220 shell steps in one turn; if the
agent ends early, the driver sends “Continue the batch”. Once the first batch's
step target is reached, it waits for idle (interrupting at that batch boundary if
needed), changes AGENTS.md, and sends the next batch in the same session. The
remaining step budget is divided among the other three batches, so defaults
exercise at least four batch messages. AGENTS.md also changes once after step 3
while the first batch is active; OpenCode 2.2.6 detects this on a subsequent pass.
Small step/spend caps or provider errors can stop before four batches; safety caps
take precedence. Model cooperation is not guaranteed; inspect recorded commands.

The throwaway host also has a local stdio MCP server with two diagnostic tools.
Its config explicitly sets `mcp.servers.issue886.codemode: true`, enabling Code
Mode for that catalog. The driver disconnects/reconnects it after steps 2, 4 and
6, and between batches. Each reconnect changes the server's tool descriptions
and server instructions through a private revision file. This makes the real
host emit Code Mode catalog and MCP-guidance updates, not just AGENTS.md changes.
Only the MCP tools use Code Mode; shell stays directly callable for the workload.
The MCP server implements legacy JSON-RPC stdio and never contacts the network.

A step is one primary coding-agent model request, not an auxiliary historian/title
request or one tool in a parallel bundle. At the next
native HTTP request hook after the cap, the diagnostic observer refuses the request
and the driver interrupts the session. The spend guard reads **all** stored
OpenCode assistant usage, including historian/hidden sessions, pricing uncached
input (and cache writes) at $0.15/M, cache reads at $0.003/M and output plus
reasoning at $0.60/M. It reserves the maximum next-call cost from input/output
limits **before** allowing any request, including concurrent title/child
calls. Auxiliary calls not stored as assistant rows are priced from the native
HTTP response usage, separately from stored usage to avoid double-counting.
At defaults that reservation is $0.0649941. The guard therefore stops
slightly *before* the dollar cap rather than promising a precise final bill.
Unsettled requests retain their maximum reservation (`outstandingReservedUSD`)
instead of being counted as free. Missing prior primary usage fails closed. Provider pricing and token-limit enforcement
must match these assumptions; this is a diagnostic guard, not a billing service.

Everything writable is under `$TMPDIR/magic-context/issue-886-live/<run>/`:
HOME, all XDG roots, CFFIXED_USER_HOME, toolchain homes, host DB, MC storage,
configs, workspace and logs. `OPENCODE_DB=opencode2.db` is the launcher's required
basename; the actual file is under the run's XDG data directory. The driver
never reads or snapshots live store contents. The launcher checks metadata-only
write fences and all process-group descriptors; an external SQLite path fails.
Runs are retained for investigation; remove their private root yourself later.

## Evidence

The printed run root contains:

- `steps.csv`: one row per primary coding-agent step, with stored provider-billed,
  uncached/cached input, output, reasoning,
  cost, threshold flag, wire estimate/billed ratio, observed prefix rewrite,
  tool-output byte share, exact HTTP body/pass draft/MC log references, and full pass-window
  log lines (including scheduler, unknown-usage wire/pressure estimates,
  final-wire telemetry, emergency tool-drop skips when the non-droppable request
  floor already exceeds the target, summary compartment
  (summarized range of earlier messages) reasons/ranges,
  historian publications and pending-op outcomes when they occur).
- `summary.json` / `summary.md`: steps over 250K, observed prefix rewrites,
  weighted cache-hit rate, weighted estimate/billed ratio, byte-weighted tool
  share, all-session spend, turn count and stop reason. A null ratio means the
  underlying telemetry was absent, not zero.
- `passes/*.json`: post-MC context-hook drafts, unmodified by the observer.
  These are not provider HTTP bodies. `wire/*.json` contains **exact HTTP request
  bodies** from OpenCode's native `session.hook("http.request")`, in live and fake
  modes; `.meta.json` records session/kind/model/URL, never authorization headers.
  `.usage.json` records usage observed through `http.response`, including title
  and historian calls that OpenCode does not store as assistant rows.
- Composition columns count system prompt, tool definitions, both history-head
  messages (`<session-history>` / `<session-history-since>` / project memory),
  id-less instruction rows and raw conversation tail. They call the **same
  `estimateTokens` tokenizer as MC final-wire telemetry**, with its fingerprint
  in the summary. Buckets count text/tool arguments, without protocol framing or
  MC's fit/calibration multipliers. DeepSeek serializes id-less systems as
  `<system-update>` blocks, sometimes merged into m1 (the second history-head
  user message, carrying changes since the first baseline) or a raw user message; the
  harness splits those blocks out so they are not mistaken for reducible history.
- `instructions/*.json` snapshots every head pass's stored `session_message`
  rows with `type='system'`; CSV records row count, text bytes and token counts.
  `instruction-schema.json` records the real table DDL and row-type counts,
  `instruction-rows.json` the final rows. In the proof, these carry
  `metadata.notice='instructions'`, `instructionSources=['core/instructions']`
  and the successive AGENTS.md revisions. Initial instructions are in the system
  prompt; later changes emit new stored rows. `last-pass.json` retains both the
  last observed context draft and its exact HTTP body for composition inspection.
  Separate columns attribute database rows and served instruction count/tokens to
  `core/codemode` and `core/mcp-guidance`. These source-specific counts overlap
  when a single system row names both sources; do not add them together.
- `magic-context.log`, `host.log`, `usage.json`: complete timeline and raw stored
  usage evidence. Pass logs cover the interval since the previous observer hook;
  async historian lines may be interleaved. Rows are paired by per-session billed
  response ordinal; `unmatchedUsageRows` must be zero for a clean capture.
- `lsof.txt`, `db-paths.json`: a final `lsof -p <host pid>` inventory plus the
  launcher's whole-process-group DB-path validation, taken before shutdown.

“Prefix rewrite” compares prior served draft messages/system/tools against the
next draft. It includes conversation-only rewrites, not just full history-head rebuilds,
and does not establish the provider's real cache eviction reason. Tool share is
UTF-8 serialized HTTP-body bytes, **not a token allocation**. Use billed cache counts to
check actual cache performance. This fresh session has neither the reporter's
three-day tail nor 870 compartments: a green harness proof is not reproduction
of the reported failure where non-reducible instructions/history already exceed
the execute threshold. The live run is intended to establish how pressure grows.

## Fake-provider proofs (no real API traffic)

```sh
nice -n 10 bun packages/e2e-tests/live-886/run.ts --fake \
  --step-cap 14 --batch-steps 7 --dollar-cap 8
nice -n 10 bun packages/e2e-tests/live-886/run.ts --fake \
  --step-cap 400 --batch-steps 7 --dollar-cap 0.30
```

Fake mode does not read `DEEPSEEK_API_KEY`. The host has only a loopback DeepSeek
provider with a mock key. It uses the existing e2e mock for title/historian text
and the existing valid historian payload builder. The shared mock's Chat
Completions adapter cannot emit tool calls/cache reads, so this folder adds a
small chat SSE fixture for the head: scripted shell calls create parser,
evaluator, CLI and tests, run build/tests, reread the playbook/source, and print
large fixture output. Every sixth request ends the turn to exercise continuation
and subsequent batches. Usage is scripted at 268,880 input with alternating cache
read counts, so it intentionally disagrees with the local estimator.

Expect nonempty CSV rows, `step_cap` from the 14-step run and `spend_guard` from
the $0.30 run, nonzero tool-output share, and only run-root `.db` handles in the inventory. Add
`--evidence-dir .cortexkit/internal-docs/investigations/issue-886/<proof>` to copy
fake artifacts back from a remote proof; config/keys are never copied.
Choose an empty evidence directory for each run so earlier captures cannot mix
with the new session.
Validate the copied proof directories with:

```sh
bun packages/e2e-tests/live-886/verify-proof.ts \
  .cortexkit/internal-docs/investigations/issue-886/step-cap \
  .cortexkit/internal-docs/investigations/issue-886/spend-guard
```

The Mac attempt was blocked before host startup by the native sandbox
denying the existing metadata fence's `lstat ~/.gnupg`. No live DB was opened.
The end-to-end proofs therefore ran on remote Linux; the launcher safety fence
was not weakened. Run the live Mac command from a terminal permitted to inspect
home-directory metadata; do not bypass that safety fence.

Targeted checks:

```sh
bun test packages/e2e-tests/live-886/launcher-options.test.ts packages/e2e-tests/live-886/measurements.test.ts
bun run --cwd packages/e2e-tests tsc --noEmit -p live-886/tsconfig.json --extendedDiagnostics
```
