# TS ↔ Rust transform structural parity hunt #2

Audit date: 2026-08-25

## Scope and method

This hunt reused and extended `scripts/audit-transform-wire-parity.py`; it did not reconstruct transform state from telemetry. The primary evidence is the serialized Anthropic request body, with the adjacent response used only to bound pressure. The reproducible snapshot command was:

```sh
python3 scripts/audit-transform-wire-parity.py \
  "$TMPDIR/opencode-anthropic-auth-dumps" \
  --date 2026-08-25 \
  --after 2026-08-25T12 \
  --before 2026-08-25T18-35-02-540Z-000388-ses_06be916fbffezpvuoIO3ac4yMZ-direct-sticky-ufuk2.body.json \
  --per-session 1000
```

The snapshot contains 23 Rust-lane requests, all from ASTRO (`ses_08df2045bffeBcWcqw60elghER`), and 365 TypeScript-lane requests from 19 sessions. ENGRAM produced no retained request in the window. Companion responses were 387 status 200 and one TypeScript status 520 with no diagnostic payload.

The differ now reports:

- newest-assistant reasoning presence and complete block vectors;
- system-guidance/date co-location, separator bytes, and normalized guidance suffix hashes;
- m0/m1 section order and inter-section separators;
- compartment-heading grammar;
- text-class denominators, tag placement, prefix format, and transport-reminder temporal exclusion;
- Channel-1 exact and normalized reminder shapes, bands, dampening forms, and displayed denominators;
- dropped-provider shapes, reduced tool-arc shapes, skeleton recency at observation time, and evidence excerpts;
- adjacent response input-token bands and the maximum observed request;
- `--before` as a reproducible upper bound.

TypeScript is the specification unless the TypeScript behavior is itself demonstrably wrong. Unlike-input lane counts are treated as discovery signals, not proof; source and native-store checks remove those confounds where possible.

## Outcome

One small Rust parity defect was found and fixed: Channel-1 and Channel-2 copy displayed the usage-reported context limit instead of the host's `usableSoft` window. One production-wire observation remains for follow-up: two old TypeScript wake reminders still carry temporal markers despite the current source exclusion. No other structural divergence was established. In particular, this hunt does **not** turn the absence of authored reasoning or high-pressure traffic into a defect.

## Findings

### F1 — fixed: Rust nudge copy used the usage limit instead of `usableSoft`

**Wire evidence**

The calmer-copy body itself is byte-identical after normalizing only the numeric operands and optional reclaim hint. The normalized urgent template has the same SHA-256 prefix, `c0140fa2895b615e`, in both lanes. The displayed window operand differs:

- Rust / ASTRO, `2026-08-25T17-50-09-799Z-000024-ses_08df2045bffeBcWcqw60elghER-direct-sticky-ufuk2.body.json`, message 42, block 0:
  ```text
  <system-reminder>
  Housekeeping backlog: ~101k of this session's ~1000k window is spent tool output — worth a ctx_reduce pass now. This is routine and lossless; it is never a reason to change scope.
  …
  </system-reminder>
  ```
- TypeScript, `2026-08-25T17-49-27-041Z-000004-ses_00ed68536ffeah34foNE2loI5i-direct-sticky-main.body.json`, message 460, block 0:
  ```text
  <system-reminder>
  Housekeeping backlog: ~185k of this session's ~872k window is spent tool output — worth a ctx_reduce pass now. This is routine and lossless; it is never a reason to change scope.
  …
  </system-reminder>
  ```

These are different sessions, so the bytes alone do not prove the denominator defect. Source does:

- TypeScript passes its resolved usable window as `usableWindow` at `packages/plugin/src/hooks/magic-context/transform.ts:2148-2174`, carries it in Channel-1 state, and renders it at `hook-handlers.ts:484-519` / `ctx-reduce-nudge.ts:243-277`.
- Rust correctly receives `geometry.usable_soft`, but `effective_context_limit_tokens` deliberately lets a populated usage denominator win for scheduler-band compatibility (`crates/mc-module/src/transform.rs:5782-5800`). Both Channel-1 and Channel-2 then reused that scheduler denominator at `transform.rs:5199-5213` and `:5393-5409`.

**Adjudication**

The scheduler's compatibility rule is not wrong, but it is the wrong operand for user-facing nudge copy. `usableSoft` is the host's resolved working window and is the TypeScript display contract. Showing `~1000k` where the usable window is `~872k` understates the displayed fraction and breaks the explicit `usableSoft` parity axis.

**Severity:** low ICL/copy accuracy; no provider, cache, or selection-policy effect.

**Disposition:** fixed here. Scheduler pressure still uses the usage-reported denominator. A separate display helper prefers plausible `geometry.usable_soft` and falls back to the scheduler denominator only when geometry is absent or implausible; both Channel-1 and Channel-2 use it. A red-first regression reproduced `1000000` instead of `872000`, and the corrected test pins scheduler/display separation.

### F2 — follow-up confirmation: two TypeScript wake reminders still carried temporal markers

**Wire evidence**

The fresh snapshot has 9,739 TypeScript transport-reminder carriers with no temporal marker and 2 with one; Rust has 1,102 without and zero with one. Both exceptions are in the same old TypeScript session:

- `2026-08-25T17-50-29-551Z-000036-ses_0b80d7b39ffeNAo68snl48kErV-direct-sticky-main.body.json`, message 410, block 0:
  ```text
  §21258§ <!-- +2h -->
  <system-reminder>
  Wake digest
  …
  </system-reminder>
  ```
- The same body, message 416, block 0 begins `§21263§ <!-- +2h -->\n<system-reminder>\nWake digest`.

A read-only native-store cross-check found the corresponding wake-digest parts without either temporal prefix. They are synthetic transport text in native storage, not authored user messages whose bytes happened to quote reminder markup.

**Source cross-check**

- Current TypeScript `hasMeaningfulUserText` removes every `<system-reminder>…</system-reminder>` span before deciding authored-user eligibility (`packages/plugin/src/hooks/magic-context/read-session-formatting.ts:33-50`; remover at `packages/plugin/src/shared/system-directive.ts:7-9`). `injectTemporalMarkers` calls that predicate at `temporal-awareness.ts:153-188`.
- Rust's explicit authored-user predicate excludes synthetic and whole-reminder transport messages at `crates/mc-module/src/transform.rs:8496-8513`.

**Adjudication**

The current sources agree and the overwhelming wire population is clean. The two clean-native/stale-wire rows prove that this old TypeScript process or its replay state still served pre-fix temporal bytes; they do not identify a current-source branch to change. This is production activation/replay confirmation, not a reason to weaken the authored-user predicate or strip arbitrary historical user bytes.

**Severity:** low ICL/cosmetic temporal semantics; no provider or cache-shape risk beyond the stale prefix.

**Disposition:** follow-up. After a TypeScript host restart on the current bundle, replay this session and verify both wake rows lose only `<!-- +2h -->\n`. If they survive, capture the transform process version and trace the replay source before changing code.

## Axis results

### 1. Newest-assistant thinking presence

The requested axis was already present in the hunt-1 differ and was retained. In the frozen snapshot:

- Rust: `absent=23`, `present=0`.
- TypeScript: `absent=241`, `present=124`.

That raw lane difference is not a regression. A read-only ASTRO native-store query over the post-deploy interval found 122 messages, 100 assistant messages, and **zero native reasoning parts**. For example, Rust body `2026-08-25T17-50-09-799Z-000024-…body.json` ends at message 1157 with `[tool_use]`, matching its native authoring shape. There was no signed newest reasoning for the deployed Rust lane to preserve.

Current Rust separately pins the newest-only policy and the full/incremental native attachment belts at `crates/mc-module/src/lib.rs:11719-11789` and `:18814-19010`. Production confirmation of f120b491 therefore remains an evidence gap: capture the first post-deploy ASTRO or ENGRAM request whose native newest assistant actually contains signed reasoning and compare its exact signature-bearing block on wire. No code change is justified from this sample.

### 2. Tag overlay scope and reminder exclusion

Positive wire carriers establish the same format and placement:

- Rust: 2,445 assistant text prefixes, 3,170 user text prefixes, and 10,504 textual tool-result prefixes.
- TypeScript: 46,844 assistant text prefixes, 22,587 user text prefixes, 108,777 string tool-result prefixes, and 398 `content[0].text` tool-result prefixes.
- Every official prefix matched `^§[0-9]+§ `: section signs around decimal digits, one trailing ASCII space, and placement at byte zero. Temporal carriers in both lanes use `§N§ <!-- +… -->\ntext`, never temporal-before-tag.
- Synthetic m0/m1, thinking/reasoning, media, and tool calls remain unprefixed.
- Dropped sentinels are not official leading overlays; their provider-visible identity is `[dropped §N§]`.

The source scopes agree. TypeScript walks text and tool-result parts at `packages/plugin/src/shared/tag-transcript.ts:207-576`, with prefix application at `:814-888` and `:905-973`. Rust's single mint/render predicate admits user/assistant text plus textual/error-text tool results, including the first textual child of content arrays, and excludes synthetic/system/non-text carriers (`crates/mc-module/src/transform.rs:7938-7965,8171-8274`).

Two untagged Rust auxiliary reminder blocks and one untagged auxiliary tool result were newly attached without a stable overlay row; many TypeScript sessions likewise contain legacy or untagged historical parts. Neither lane exposed a prefix grammar or eligible-row rendering mismatch. Reminder **temporal** exclusion is covered separately by F2.

### 3. Channel-1 nudge rendering

Real wire traffic covered all four TypeScript shapes (gentle, firm, urgent, sticky dampening) and Rust urgent. Rust urgent normalizes to the same exact template hash as TypeScript urgent. The TypeScript and Rust renderers are otherwise byte twins at `packages/plugin/src/hooks/magic-context/ctx-reduce-nudge.ts:243-277` and `crates/mc-module/src/transform.rs:10098-10125`:

- band vocabulary: `gentle`, `firm`, `urgent`;
- sticky one-liner: `Reminder: ctx_reduce housekeeping still pending —`;
- identical punctuation, em dashes, line breaks, reclaim-hint layout, and `Math.round`/Rust `round` `Nk` formatting;
- identical severity boundaries via `decideChannel1` and `hygiene_band`.

F1 fixes the only operand mismatch. The reminder-span accounting exclusion itself is byte-identical: TypeScript strips repeated trailing `\n\n<system-reminder>…\n</system-reminder>` spans at `tail-hygiene-walk.ts:252-260`; Rust uses the same delimiters and loop at `tail_hygiene.rs:76-85`.

### 4. Emergency and pressure shapes

The snapshot contains no high-pressure request. Rust response totals are all 500k-750k with a maximum of 614,178 input tokens; TypeScript's maximum is 655,246. No request reached the differ's 750k evidence band, much less a derived emergency boundary, so no fresh drop can honestly be attributed to emergency tiering.

The visible reduced grammar is nevertheless aligned:

- Rust: 621 exact `[dropped §N§]` tool-result carriers.
- TypeScript: 31,345 exact carriers across user text, assistant text, and tool-result positions.
- No provider-visible bare `[dropped]` carrier occurred.
- Both lanes expose skeleton tool inputs through the same 500-byte clamp, five-character string prefix plus `...[truncated]`, `[N items]`, and `[object]` vocabulary. A skeleton may be older than the newest 20 at observation time because its shape is frozen at selection time; the differ reports `newest_20` versus `older_replay` rather than misclassifying replay as a window violation.

Source parity is explicit:

- TypeScript computes the newest-20 freeze-time skeleton window at `apply-operations.ts:93-102`, renders `[dropped §N§]` and clamped inputs at `tool-drop-target.ts:107-154,227-245`, and walks emergency T3→T2→T1 at `emergency-drop.ts:103-277`.
- Rust computes the same newest-20 window at `selection.rs:1306-1351`, uses the same clamp at `:657-701`, and implements the same floor, 20% per-tier reserve, and T3→T2→T1 walk at `:1009-1104`.

Emergency tiering remains a real-wire evidence gap, not a claimed runtime pass.

### 5. System-prompt composition

All 388 bodies have the same four provider system blocks. In every body:

- exactly one block contains `## Magic Context`;
- the date line and guidance are co-located in provider `system[2]`;
- exactly `\n\n` precedes the guidance marker;
- the guidance suffix is byte-identical across lanes: length 9,329, SHA-256 prefix `ff01f944650f29a6`;
- the date is the correct `Tue Aug 25 2026` in the audited examples.

The host hook fixes strict OpenAI-compatible serializers by concatenating guidance into `output.system[0]` with a blank line (`packages/plugin/src/hooks/magic-context/system-prompt-hash.ts:348-380`). That hook is registered independently of transform lane at `hook.ts:1440-1496`. Rust native serving never composes a competing system array—`TransformRequest` carries only the hash/selection metadata plus messages (`crates/mc-module/src/transform.rs:637-837`). Provider adapters prepend billing/CLI blocks, which is why the combined host entry appears as provider index 2 rather than index 0. No Rust-specific second-system-message path was found.

### 6. m0/m1 internals

Fresh wire layout and common-source renderers agree:

- Rust m0 order in all 23 bodies: `project-docs → user-profile → session-history → project-memory → memory-mural`.
- TypeScript m0 varies only by absent optional blocks. Every observed order preserves `project-docs → user-profile → session-history → project-memory → memory-mural`, with exactly one blank line between present sections.
- The mural cue bytes are identical—`<memory-mural>\nThe project memory mural image follows.\n</memory-mural>`—and the image block follows m0 text immediately, before m1 (`inject-compartments.ts:2000-2059,2941-2982`; `m0_compose.rs:22-23`; `transform.rs:6869-6894,2927-2933`).
- Rust emitted the wrapped m1 placeholder at block 2 in all 23 bodies. TypeScript emitted it at block 1 without a mural and block 2 with one.
- Twenty-four TypeScript bodies carried a non-empty m1 in exact order `memory-updates → new-compartments → new-memories`, separated by one newline. Example: `2026-08-25T18-15-28-568Z-000254-ses_227ce5788ffeRPA9THoPLOQreO-direct-sticky-yiyi.body.json`, message 0, block 2 begins:
  ```text
  <session-history-since>
  <memory-updates>
  These memories changed since the snapshot below — trust these:
    <updated id="11022">…</updated>
  …
  ```
- All 3,013 Rust and 86,926 TypeScript compartment headings matched `## start-end[ · date-range] · title` exactly.

The byte producers match on the requested internals: TypeScript `renderM0`, `renderM1WithMetadata`, `renderMemoryUpdatesBlock`, and `compartmentHeading` at `inject-compartments.ts:2012-2059,2471-2684` and `decay-render.ts:62-66`; Rust `render_m0`, `assemble_m1`, `render_memory_updates`, and `compartment_heading` at `memory_render.rs:205-337` and `decay_render.rs:123-136`. Shared cross-language memory/project-doc goldens additionally pin escaping, profile lines, update branches, and ordering.

Rust's optional `<covered-system-messages>` and module-owned `<new-notes>` extensions did not occur in this OpenCode snapshot. They are outside the listed common blocks and remain evidence gaps rather than invented divergences.

### 7. Additional differ output

No new provider-shape failure appeared:

- the sole non-200 response was a diagnostic-free 520 for `2026-08-25T18-19-34-448Z-000293-ses_313660571ffeZTsf4koSJwk50Q-direct-sticky-yiyi.body.json`; its tail was a matched assistant `tool_use` / user `tool_result` arc and its reasoning order occurs in accepted TypeScript bodies, so there is no evidence to attribute the transport response to transform shape;
- no duplicate tool-use IDs, orphan tool results, or tool uses without results were found;
- all accepted requests ended in a provider-valid user tail;
- the m1 wrapper, tag-before-temporal order, and newest-only reasoning source policy remain present after the hunt-1/follow-up changes.

Apart from F1 and the F2 activation/replay observation, the extended differ surfaced no adjudicable TS↔Rust structural defect.

## Verification

- `python3 -m py_compile scripts/audit-transform-wire-parity.py` and the frozen differ assertion block — passed; the assertion block pins snapshot counts, statuses, system/guidance identity, heading grammar, transport-reminder exceptions, urgent template identity, wrapped m1, and zero tool-arc anomalies.
- `cargo test -p mc-module --lib nudge_display_denominator_prefers_geometry_usable_soft -- --nocapture` — red before the fix (`left: 1000000`, `right: 872000`), then green.
- Post-fix mutation changing the display helper back to the scheduler denominator — the same test reddened `1000000 != 872000`; the mutation and `NON-VACUITY BREAK` marker were restored, and the test returned green.
- `cargo fmt --all -- --check` — passed after formatting.
- `cargo test -p mc-module --lib` — 985 passed, 0 failed, 4 ignored.
- `bun test packages/plugin/src/hooks/magic-context/ctx-reduce-nudge.test.ts packages/plugin/src/hooks/magic-context/tail-hygiene-walk.test.ts packages/plugin/src/hooks/magic-context/system-prompt-hash.test.ts` — 87 passed, 0 failed.
- The nudge-hygiene, selection, temporal-parity, and merged-reasoning goldens were regenerated from their TypeScript generators; no golden bytes changed.

The dump and native-store audit was read-only. No push or deploy was performed.
