# Live provider harness

Opt-in, billed tests through **OpenCode 1.18.30** and the locally built Magic Context
plugin. Bedrock is no longer selected or requested from the vault. The legacy Bedrock
wire reader remains usable for old captures.

| Route (`--only`) | Credential | Auth / wire |
| --- | --- | --- |
| `claude-oauth:trim-only` | `oauth:anthropic` | Installed `anthropic-auth` dist, native Messages, Opus 5.5 |
| `codex:age` | `chatgpt:openai` | Installed `openai-auth` dist, Codex HTTP Responses, GPT-5.4 mini |
| Existing API-key routes | OpenAI, OpenRouter, DeepSeek, Kimi keys | Existing adapters |

## Credentials and isolation

The enrolled vault consumer is **`mc-e2e`**, not either auth plugin's operator
enrollment. The only real config file the runner needs to read is that consumer's
own `~/.config/cortexkit/mc-e2e/enrollment.json`, or an explicitly provisioned
`MC_E2E_ENROLLMENT_PATH`. Do not read operator OpenCode/config/auth files to discover
plugin paths or credentials.

Supply an **existing absolute OpenCode dist path** with `--anthropic-auth` /
`--openai-auth` (or `MC_LIVE_ANTHROPIC_AUTH_PLUGIN` /
`MC_LIVE_OPENAI_AUTH_PLUGIN`). Missing dists fail before credential retrieval;
the harness never builds those checkouts. The host loads the dist by `file:` URL.

The vault serves access bearers. The runner reads one selected credential once per
run and reuses it across that route's scenarios. No roster traversal or account
rotation occurs. `--claude-credential oauth:anthropic:NAME` selects **one** explicitly
authorized account; it is not automatic rate-limit fallback.

Each host has a new root beneath `$TMPDIR/magic-context/`. Its HOME, all XDG roots,
OpenCode DB/config, MC storage/log, work directory, and child TMPDIR are inside
that root. The bearer is written in mode 0600 to the disposable host login slot.
An inert, non-secret `mc-e2e-refresh-disabled` placeholder fills the refresh field
because the Claude plugin requires a nonempty slot. It cannot refresh an account;
background refresh, cache keep-warm, request dumps, and Anthropic fallback accounts
are disabled. The plugins' own config/state paths are explicitly disposable.
Codex is forced to HTTP through the recorder, not WebSocket transport.

`lsof -p <pid>` must show database handles **only** beneath the throwaway root,
before prompts and after the scenario. Missing samples, external DBs, and
prefix-lookalike paths fail closed. Results retain normalized database paths and
the host PID. This is sampled host isolation, not a continuous descendant/network
sandbox. Startup failure, normal exit, and SIGTERM/SIGINT delete the entire root,
including credential-bearing auth state. Never retain or commit that root.

## Opus preserved-thinking check

```sh
MC_LIVE_PROVIDERS=1 MC_LIVE_MAX_CALLS=24 timeout --kill-after=30s 600s \
  bun packages/e2e-tests/src/live-providers/runner.ts \
  --only claude-oauth:trim-only \
  --anthropic-auth /absolute/anthropic-auth/packages/opencode/dist/index.js \
  --out "$TMPDIR/magic-context/live-providers/run-UNIQUE"
```

The scenario requests a sequence of twelve tiny `echo` tool steps (the age setting
has a minimum of ten tags), then closes the round. `/ctx-flush` authorizes a
rebuilding pass. A short math follow-up exercises oldest-prefix removal; a second
follow-up measures cache reads without another flush. Finally, the harness queues
a drop on the oldest tool result and flushes again before a third short math turn.
MC itself selects, persists and applies edits; the recorder **does not rewrite the
request history**. Thinking is adaptive, effort low, and output capped at 1024.
The subscription plugin forces prefix-mismatch `error` with the matching beta
when replaying signed thinking.

`trimOnly.qualified` requires wire evidence, not just HTTP 200: a nonempty gap-free
oldest prefix removed with newer identical signed blocks retained; unchanged old
non-thinking content/system/tools; no restoration on the next request; a positive
cache read larger than on the trimming request, with the trimmed prefix replayed
identically; an earlier tool-result edit with all later signed blocks removed;
accepted responses with usage and no transformation diagnostics. A seed lacking
thinking, extra MC edits, or absent usage is **not qualified**. The CLI exits
nonzero for aborted/unqualified scenarios.

`results.json` records each request's shape, model/cap/thinking flags, hashed signed
and non-thinking blocks, upstream status/request ID, uncached input, cache reads,
cache writes, output, and response transformation diagnostics (including nested
SSE metadata). Empty diagnostics mean none observed, not that the request was
accepted. Optional `--keep-bodies` retains content but no headers; default results
do not retain thinking text/signatures. Always inspect diagnostics before drawing
acceptance conclusions. Never treat uncached input alone as total Anthropic input.

The recorder caps calls and stops upstream forwarding on the first rejection.
It records the real upstream status but returns a local HTTP 400 to the host to
avoid the subscription plugin sleeping/retrying on 429. Locally refused retries
are counted separately; they consume no model calls.

The first live attempt is documented in
[`live-opus-55-trim-only-2026-10-04.md`](../../../../docs/reports/live-opus-55-trim-only-2026-10-04.md).
Both authorized accounts were rate-limited before thinking generation: acceptance,
trim-only behavior, mixed-edit stripping and cache reads remain **unverified live**.

## Independent preserved-thinking wire matrix

For an isolated signature-rule experiment, rather than MC's actual age/flush
behavior, use the native Messages matrix. Prefer a recorded request containing at
least six signed blocks across three assistant messages, with intervening tool
calls. Copy only selected request bodies into
`~/.local/share/cortexkit/magic-context/specimens/thinking-matrix/` as mode-0600
regular files; never put them in the repository. The source dumps are read-only.

```sh
MC_LIVE_PROVIDERS=1 MC_LIVE_MAX_CALLS=9 \
MC_E2E_ENROLLMENT_PATH=/explicitly-authorized/mc-e2e/enrollment.json \
  bun packages/e2e-tests/src/live-providers/thinking-matrix-live.ts \
  --opencode /absolute/opencode-1.18.30 \
  --anthropic-auth /absolute/anthropic-auth/packages/opencode/dist/index.js \
  --opus-seed "$HOME/.local/share/cortexkit/magic-context/specimens/thinking-matrix/opus-5-5-recorded.json" \
  --out "$TMPDIR/magic-context/live-providers/thinking-matrix-UNIQUE"
```

Add `--sonnet-seed` only if a qualifying Sonnet 5.5 body exists (and set the total
cap to at most 18). An omitted model is skipped, never seeded synthetically. The
recorded seed must already contain `thinking.type: adaptive` and
`output_config.effort`; no compatibility shim is applied. Its history, system,
tools and effort remain unchanged in the control. All cells share a 64-token
output cap, non-streaming transport, and strict block binding with its beta.

The recorded mode sends at most nine one-shot requests per model: unchanged
control, oldest-one trim, suffix removal (all but the oldest signed block), all
thinking removal, second-block gap with later blocks kept, restoration, earlier
tool-result edit, first-user re-render, and literal `[cleared]`. Restoration
reuses the prefix-trim response only if it produced a new signed block; otherwise
the cell is explicitly not reached and the run exits nonzero. No tool is executed:
new tool calls in that response get local error results for the restoration probe.
Every other cell is an independent clone of the same seed. The restoration probe
does not undo a rejected middle gap; it tests reinserting the removed oldest block
after generation while that block was absent. Any rejected control, 429 or quota
error stops the entire run without retries or changing credentials. Error bodies
are preserved in full except for secret/conversation redactions, alongside usage
and hashed request shapes. No raw body or signature is retained in the output.

The older synthetic seeding mode remains available when neither seed flag is
provided, but its Oct 8 attempts produced insufficient signed history:

```sh
MC_LIVE_PROVIDERS=1 MC_LIVE_MAX_CALLS=92 timeout --kill-after=30s 600s \
  bun packages/e2e-tests/src/live-providers/thinking-matrix-live.ts \
  --opencode /absolute/opencode-1.18.30 \
  --anthropic-auth /absolute/anthropic-auth/packages/opencode/dist/index.js \
  --out "$TMPDIR/magic-context/live-providers/thinking-matrix-UNIQUE"
```

This uses only `oauth:anthropic`, read once through `mc-e2e`. The installed auth
plugin first shapes a request against a **loopback-only** rejection; that bootstrap
spends no model quota and deletes its disposable credential root. The native
client then keeps the captured bearer headers and signed history only in memory.
It explicitly requests strict thinking binding and its beta. A seed refusal gets
one neutral-prompt retry; 429s and other errors are never retried. Alternate accounts,
persistent raw bodies, and signature dumps are not supported.

Each model gets one conversation with completed `record_note` tool rounds. Every
seed request uses adaptive thinking at high effort with a 1,152-token response
cap, the supported mode for Opus 5.5 and Sonnet 5.5. Adaptive thinking can still
skip a block on an easy turn, so the runner counts actual signed blocks and
continues for up to eight rounds until at least four exist across at least two
completed rounds. A refusal on a seed request gets one retry with a different
neutral arithmetic prompt; other errors are not retried. The tool and prompts
only use harmless short arithmetic results. There is no cache ballast: the matrix
measures signature binding, not prompt-cache behavior.

Every next-request variant is a fresh copy of the same seed, and both models run
the same common cells: control, oldest one/two, middle-only, suffix and all
removal, tool-input and tool-result edits (each keep/strip pair), first-user
re-render (keep/strip), and literal `[cleared]`. The restore check reuses the
oldest-one response and makes one follow-up request only if that response contains
a new signed block generated while the prefix was absent. Branch responses never
enter another branch's history. A 429 stops the whole run immediately; no account
rotation or retry occurs. Authentication rejection also stops both. The hard cap
is 92 calls: enough for eight rounds and one refusal retry per tool/final request
for both models, plus every common cell and restore check. Errors, missing signed
history, and an unreached restore check exit nonzero and leave reached-call
evidence in `results.json`.

`completed` means every one-shot cell and the restore check were reached, **not**
that all memory claims were validated. Inspect per-variant status/request IDs and
transformation diagnostics, particularly the unchanged control. The Oct 7 quota
block and the Oct 8 insufficient-seed runs are recorded in
[`live-thinking-trim-opus-5-5.md`](../../../../docs/reports/live-thinking-trim-opus-5-5.md).

## Local verification

```sh
timeout 90 bun test --timeout 30000 packages/e2e-tests/src/live-providers
timeout 90 bun packages/e2e-tests/node_modules/typescript/bin/tsc \
  --noEmit -p packages/e2e-tests/tsconfig.live-providers.json
```

An optional installed-dist smoke test uses **fake** bearer fixtures and a loopback
model upstream, with no vault access or billed model calls:

```sh
MC_LIVE_AUTH_SMOKE=1 MC_LIVE_OPENCODE=/absolute/opencode \
MC_LIVE_ANTHROPIC_AUTH_PLUGIN=/absolute/anthropic-auth/packages/opencode/dist/index.js \
MC_LIVE_OPENAI_AUTH_PLUGIN=/absolute/openai-auth/packages/opencode/dist/index.js \
  timeout --kill-after=30s 180s bun test --timeout 120000 \
  packages/e2e-tests/src/live-providers/auth.test.ts
```
