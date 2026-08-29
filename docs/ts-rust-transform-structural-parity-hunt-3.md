# TS ↔ Rust transform structural parity hunt #3

## Scope and method

The primary evidence remained serialized Anthropic request bodies. The audit did not reconstruct provider messages from transform state. The reproducible configured-lane snapshot was:

```sh
python3 scripts/audit-transform-wire-parity.py \
  "$TMPDIR/opencode-anthropic-auth-dumps" \
  --date 2026-08-26 --after 2026-08-26T12-30 --per-session 1000 \
  --context-db "$HOME/.local/share/cortexkit/magic-context/context.db" \
  --store-db "$HOME/.local/share/cortexkit/magic-context/store.db"
```

It contains 227 requests assigned to the three requested Rust projects and 1,366 requests from the other 19 sessions; all 1,593 companion statuses are 200. Telemetry then found that SUBCONSCIOUS was not actually serving through Rust (finding F2). Re-running with only the two observed Rust sessions produced 92 Rust and 1,501 TypeScript bodies. Unlike-session counts are discovery evidence only; byte-template and source/fixture comparisons remove the scale confound.

A second frozen all-session snapshot, bounded at request `2026-08-27T05-38-29-059Z-001994-ses_227ce5788ffeRPA9THoPLOQreO-direct-sticky-yiyi`, covered 2026-08-27 post-deploy traffic: 64 configured-Rust and 337 TypeScript bodies. The adjacent `.meta.json` `id` is the request identifier used below. The audit script now reports project roots, reduced-representation vocabulary, compaction markers, media shapes, exact nudge assembly, caveman state, transform decisions, module activity, and matched input-state predicate bands.

## Findings

### F1 — fixed as a TypeScript bug: memory-off could replay one memory-bearing cache entry

**File evidence and non-vacuity**

`mustMaterialize` receives `memoryEnabled`, but before this change it had no direct memory-on → memory-off predicate (`inject-compartments.ts:1529-1684`). It relied on the system hash. The transform itself documents that `messages.transform` observes the persisted previous system hash because `system.transform` runs later (`transform.ts:2101-2107`). Therefore the first memory-off message pass could replay cached memory-bearing m0/m1 bytes before the changed system hash arrived on the next pass. That violates the documented invariant that `memory.enabled=false` suppresses every memory-derived surface.

The focused transition test now deliberately keeps the old system hash and requires an immediate `render_config` HARD decision. Disabling the new predicate under `NON-VACUITY BREAK` made the test fail with `expected render_config, received null`; the break was restored and the test returned green.

**Adjudication:** **TS-bug** (the allowed exception to TypeScript-as-spec). The invariant is documented in `docs/issue-368-memory-gate-report.md:28-42`; a one-request memory leak is not an acceptable cache-stability trade.

**Disposition:** fixed. `mustMaterialize` performs a self-consuming check: when memory is off and cached m0 or m1 contains `<project-memory>`, `<user-profile>`, `<new-user-profile>`, `<memory-updates>`, or `<memory-mural>`, it folds immediately. The sanitized bytes contain none of those blocks, so subsequent defer passes remain byte-stable without a schema flag.

A new hermetic differential fixture starts memory-off, sends a real TS request, restarts the same data dir into Rust mode, and sends a real Rust request. Both served wires omit all five memory surfaces and the `ctx_memory` tool. The existing seeded TS and Rust compose fixtures supply non-vacuity for profile, delta, mural, and project-memory data; there is still no production memory-off Rust session.

### F2 — operational gap: SUBCONSCIOUS was configured as Rust but served TypeScript

**Evidence**

- Project-root extraction maps `ses_12a4fa38dffe81Fz7Y2AsWb5Cg` to `/Users/ufukaltinok/Work/Projects/CortexKit/subconscious`.
- In the 2026-08-26 snapshot it produced 135 served bodies. Its 395 same-window `transform_decisions` rows contain TypeScript-only hash operands in all 395 rows; decisions are 394 `defer` and one `execute/pressure_refold`.
- `store.db.mc_cache_state.last_activity_at` for that session is `2026-07-22T21:41:50Z`, outside the audit window, and it has no same-window `mc_pass_trace` scheduler history. By contrast ASTRO/ENGRAM rows have null TypeScript-only operands and current module activity.
- The frozen current-day snapshot reproduces it: 30/30 SUBCONSCIOUS rows have TypeScript-only operands and no current module activity.

**Adjudication:** **benign-documented for transform bytes, but an activation/deployment gap**. Treating these bodies as Rust would contaminate every parity denominator. There is no repository transform fix justified by wires that never traversed Rust.

**Fix brief:** inspect SUBCONSCIOUS's effective project `transform_mode`, user-tier subc connection, module status/provenance, and route binding; restart that host after restoring the Rust route. Acceptance is one fresh served request whose decision row has all six TypeScript-only operands null plus current `mc_cache_state`/`mc_pass_trace` activity. Then re-run this audit with all three sessions genuinely observed as Rust.

**Post-delivery correction (review):** the "configured as Rust" premise came from the hunt brief, not from configuration — the live project config at `subconscious/.cortexkit/magic-context.jsonc` is empty, with a comment documenting the deliberate escape-hatch-off state (the July flip-back decision stands). Config = TS, wires = TS: consistent, no activation gap, no fix owed. What stands from F2: the differ must not count `subconscious` in Rust denominators (landed), and the stale July `mc_cache_state` rows for that project explain the module-side silence. The audit's wire-evidence discipline caught the contradiction the brief planted — the denominators were protected by refusing to trust the label over the bytes.

## Per-axis verdicts

### 1. Fresh de-gauged nudge assembly

**Verdict: pass where observed; TypeScript live-occurrence gap.** The first post-deploy de-gauged wire occurrence is Rust/ASTRO request `2026-08-27T04-33-39-205Z-001881-ses_08df2045bffeBcWcqw60elghER-direct-sticky-ufuk2`, message 440, block 0. It is a suffix inside the textual content of a sole `tool_result` block, begins with exactly two newlines, contains one `<system-reminder>` span, and renders the hint on its own line:

```text


<system-reminder>
Housekeeping backlog: 99 spent tool outputs (~94k tokens) are reclaimable — a ctx_reduce pass is due.
oldest reclaimable: §8642§ bash · §8662§ bash · §8683§ bash · §8689§ bash.
</system-reminder>
```

The same frozen span appears in 14 later accepted bodies. No post-deploy TypeScript body contains a newly emitted de-gauged reminder; 337 TypeScript bodies carry only older frozen gauged spans. That is an honest production evidence gap, not a byte failure. The shared copy remains unit-pinned. The differ now separates gauged/degauged, Channel 1/2, band, full/suffix placement, carrier vector, and hint-line presence so hunt #4 can capture the first TypeScript occurrence.

### 2. Reduced-arc skeleton/edit-marker/drop vocabulary

**Verdict: pass for all live classes; skeleton has no live Rust occurrence.** With observed lanes:

- Rust request `2026-08-26T15-40-02-795Z-000043-ses_0ad83017cffexe0g5N8UG0y3LZ-direct-sticky-ufuk2`, message 135/block 0, carries a Write edit-marker preserving `filePath` and a 40-character `content` region prefix followed by exact `...[truncated]`. The Rust snapshot has 35 such frozen arcs.
- TypeScript request `2026-08-26T15-38-39-385Z-000017-ses_0758f6ce7ffeJ0A9sV8Qvema7d-direct-sticky-ufuk2`, message 695/block 0, has the same 40-character Write vocabulary; the snapshot has 1,372.
- Rust request `2026-08-26T15-39-15-867Z-000025-ses_08df2045bffeBcWcqw60elghER-direct-sticky-ufuk2`, message 14/block 0, and TypeScript request `2026-08-26T15-38-41-882Z-000018-ses_00ed68536ffeah34foNE2loI5i-direct-sticky-yiyi`, message 8/block 0, both render exact `[dropped §N§]`.
- No current body in either lane contains the historical `{reduced,summary}` envelope. Actual Rust traffic did not freeze a skeleton in this window. The TS differential selection golden pins the shared five-character skeleton clamp, array/object vocabulary, edit-marker top-level semantics, and drop ordering in Rust.

Search-hint-bearing drops are now classified separately from exact sentinels instead of being counted as visible text.

### 3. Caveman tiers on aged sessions

**Verdict: pass; same freeze-time age basis.** Live aged state exists in both lanes. ASTRO has depth counts `lite=54/full=53/ultra=54`; ENGRAM has `291/463/708`. TypeScript sessions likewise carry all three depths (for example AVATAR `41/40/41`). Rust stores `caveman_age_basis_tag` at the maximum tag of each genuine bust and reuses it on defer (`transform.rs:4351-4370`). TypeScript computes the maximum tag from the bust snapshot and only replays persisted depth on defer (`caveman-cleanup.ts:104-133,198-265`). Both implement oldest-first eligible ordering and 20/20/20/40 tiers. The cross-language `caveman-golden.json` pins the exact text compressor bytes. Different source prose means live output strings are not falsely compared as rates or byte twins.

### 4. Compaction marker and summary-row shapes

**Verdict: pass.** Rust request `...000025...ASTRO`, message 1/block 0, and TypeScript request `...000018...AVATAR`, message 1/block 0, both carry:

```text
§N§ [Compacted by magic-context — session history is managed by the plugin]
```

Every observed marker is assistant text at block 0 with the same tagged template. Sibling block vectors vary (`[text]`, `[text,tool_use]`, and merged TypeScript text variants) because the native assistant row differs; the marker block itself does not. Both lanes filter OpenCode summary rows before ordinal assignment. No untagged or alternate marker vocabulary appeared.

### 5. Channel-2 delivered shape

**Verdict: hermetic pass; no live Channel-2 delivery.** No body in either snapshot contains the exact `Routine housekeeping:` Channel-2 reminder. TypeScript `maybeDeliverChannel2` delivers a synthetic user text part through `promptAsync`; Rust OpenCode returns the same host directive and the host uses that delivery path. Hermetic tests pin the synthetic-user echo, terminal lease, exact de-gauged copy, and no repeat. The live `tool_result` suffix shapes reported above are Channel 1, not evidence of a Channel-2 alternate encoding.

### 6. Image/attachment stripping

**Verdict: pass where observable; transcript-image Rust evidence gap.** Both lanes render the m0 mural image identically as user message 0/block 1 with keys `{type,source,cache_control}`, source `{type:"base64",media_type:"image/png",data}`, before m1. Example Rust is request `...000025...ASTRO`; the same shape appears 92 times in observed Rust traffic.

TypeScript request `2026-08-26T15-38-28-413Z-000013-ses_06be916fbffezpvuoIO3ac4yMZ-direct-sticky-ufuk2`, message 392, contains transcript images with the same source shape. No Rust request retained a transcript image in this window, so live wires cannot prove an equivalent aged image strip. Seeded DETECT/REPLAY tests pin that both lanes remove processed image blocks and replay the frozen absence without inventing a textual placeholder (`strip-content.test.ts:314-486`; `transform.rs:10488-10841,14208-14252`). No `document`, `file`, or `attachment` provider block appeared.

### 7. Decision parity

**Verdict: no structural divergence in matched states.** The differ compares predicates in matched 50k input bands, not rates across unlike windows. In the shared 250k-350k bands, Rust and TypeScript observations are all `defer` with no materialize reason, emergency, or drop. TypeScript-only higher matched states contain `execute/pressure_refold`; no Rust session reached those states, so a rate comparison would violate the scale-confound rule. Rust `scheduler_history` and `scheduler_interesting_history` agree with its normalized decision rows. No trigger/threshold predicate disagreement is established. F2 is excluded from the Rust distribution because its non-null operands prove it was TypeScript.

### 8. Additional differ output

Apart from F1 and F2, the extended differ found no unexplained provider-shape class: all responses are 200; no bare dropped sentinel, reduced envelope, orphan result, duplicate tool ID, or invalid compaction marker occurred. Historical gauged reminders remain frozen by design and are not mistaken for new post-deploy assembly.

## Verification

The implementation is verified by the commands recorded in the task delivery. In particular, the memory transition guard was red under the explicit non-vacuity mutation, the steady memory-off TS→Rust hermetic fixture passed against production-path plugin bytes, and the full plugin/Pi/Rust three-suite gate was run after the final edits.
