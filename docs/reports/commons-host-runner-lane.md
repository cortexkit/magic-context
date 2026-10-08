# Commons host runner lane — review patch

For SUBC review and merge; **not applied to commons**. The accompanying
[`commons-host-runner-lane.patch`](commons-host-runner-lane.patch) is a unified
diff against commons `master` at
`c1591d4a76fa3d3a7367237922b0bca5214dbf11` (also its inspected HEAD).
Authority: the P1–P4 / D1–D4 disposition ledger in
`.cortexkit/alfonso/drafts/host-runner-contract-extensions.md`, SUBC
`pm_11d8fb5279e7ca29` and BROCA `pm_8431d0b84664aa93`, 2026-10-08.
The accepted ledger and updated merge gate supersede that note's stale
“pending” headings; this patch does not edit the note or enable the host lane.

## Changes and condition landings

Here **H** is `crates/cortexkit-role-step-transform-provider/CONTRACT.md`,
and **C** is `crates/cortexkit-role-compaction-provider/CONTRACT.md` in commons.
Both gain a numbered **Host runner lane** section, in the existing `[pinned]`
style, without renumbering existing sections.

| Ruling | Where | Semantics and conditions retained |
|---|---|---|
| P1 `served_through_ordinal` | H §13.2; C §18.2 | Optional hook/step request sibling, not Setup/answer; absent means no promotion. Durable serving watermark; hooks use the preceding committed value and steps the post-append value. Promotion cannot pass newest held history; per-lineage forward-only except the same-transaction revert clamp; lower without revert refuses `invalid_params` naming `served_through_ordinal`, never un-promotes. Inherited-prefix promotion and burning beyond the descent boundary remain explicit. |
| P2 `unserved_subjects` | H §13.2–§13.3; C §18.2, §18.4 | Enclosing lineage, typed identities, strict hook values, ignored unknown fields, empty omitted. Idempotent burns before promotion/cadence; never-answered subjects ignored; discarded output/reductions never resurrect. Whole-message freeze and resend-until-answered preserved. The list counts toward the 3 MiB request cap. |
| P3 `subject_part` | H §13.3; C §18.2 | Hook tool part and burn-entry identity only, not top-level step/answer. Opaque, non-empty when present, ≤256 UTF-8 bytes, byte-for-byte comparison without normalisation. Actual tool part id, not `tool_call_id`; omission is the no-part identity. Malformed parts refuse by field. |
| P4 `pass_complete` | H §13.3; C §18.2 | Last-hook scheduling hint, omitted unless true; false/absent means no barrier. Only the barrier schedules evaluation after synchronized chain and complete ingest; never acknowledges service. Next pass covers a missed barrier. Zero-append `state_sync` use is MC-internal, outside both commons roles. |
| D1 admission | H §13.1; C §18.1 | Frozen plan params plus route bind `(project_root, session)` with bind harness `opencode`/`opencode2` **under the authenticated direct principal**, never body `harness` or body params. Scoped empty-group/no-ready exception grants no runner-only operation or other session. Direct-caller trust is not strengthened; daemon caller-identity stamp required once it lands. Runner principals retain full runner admission, including required groups/ready. |
| D2 observation | H §13.1–§13.2; C §18.1–§18.2 | Both frozen opt-ins and host admission required. No acknowledgement means no promotion; zero `session.read`, including restart/bootstrap. A runner principal's `observation: "answer"` or `serializer_profile: "opencode-aisdk"` refuses on `transform.declare`/`compaction.setup` with `invalid_params` naming `params.observation`/`params.serializer_profile`. |
| D3 paging / wait | C §18.3; H §13.4 | Re-page only on `more: true`, immediately with a fresh id under the same fence, not on ready/bound. No scan or held conversation lock. Final-page wait is unavailable, never a retry loop; incomplete final page refuses `history_unreadable` with the first known `history_gap_from`. Absent newest does not trigger a scan. |
| D4 status content | C §18.4; H §13.4 | **Explicit departure from C §6's suffix/final-value rule for admitted answer-observation hosts only.** Cursor is the contiguous fully hook-ingested prefix; later entries include only un-ingested opaque pre-op messages. Partial/unavailable messages still sent; empty caught-up status valid; no wire `ingested` field. Detect gaps from held history, not sparse lists; conflicts refuse before promote-and-burn. |

Cross-references land at H §4/§7/§10 and C §3/§6/§10/§15, keeping the
exceptions discoverable beside the ordinary rules. H §13.5 and C §18.5 retain
legacy/Broca/Pi/OMP behaviour, omission/lenient decoding, strict discriminants,
fences, versions, structural checks, Setup-once, budgets and `on_unavailable`.
H §13.3 and C §18.4 also distinguish compact-hook versus encoded-request
accounting, retain the host 3 MiB cap, and forbid the host oversized-entry loop
(`provider_message_too_large`) without replacing Broca's size policy.

## Vectors and handoff

Two new `host-runner-lane.json` files live in the existing root directories
`test-vectors/step-transform-provider-v1/` and
`test-vectors/compaction-provider-v1/`; each directory's README indexes them.
They use the existing named JSON collections/cases, concrete `request` objects,
and literal expected answers/refusals/effects. Route, frozen plan and durable
pre-state are fixture metadata outside wire params, documented in the READMEs.

Coverage includes every new field absent/present in its legal location; P1's
named lower-value refusal; P3 at **256** and over at **257** UTF-8 bytes (using
multibyte ids), empty-part refusal and byte-distinct ids; sparse/empty D4 status,
actual gap and pre-mutation conflict controls; final-page wait; D1's
runner-principal/host-body negative (full runner admission, not the exception),
including missing-group and forged-host-bind variants; and both D2 plan-value
refusals. Legacy corpus controls keep host extensions inert for `owned-broca`.

These are **proposed expectations**, not executed provider conformance.
The current wire types do not implement the new protocol. SUBC owns the later
type/setter, crate-version and conformance revision; this review patch changes
no Rust code, manifests or existing canonical vectors. In particular, decode
success on an older provider cannot satisfy the host-lane enablement gate.

## Validation

- `git -C /Users/ufukaltinok/Work/Projects/CortexKit/commons apply --check
  "$PWD/docs/reports/commons-host-runner-lane.patch"` — passed for all six
  target paths; Git 2.54.0 (Apple Git-157). No application performed.
- One-off Python 3.9.6 `unittest` checks against the **delivered patch**, not
  its generator — 10 structural/fixture checks passed: six-path scope,
  omission/presence, P1 named lower refusal, actual P3 byte boundaries, D1
  principal negative, D2 named plan-value refusals, D4 sparse/gap consistency,
  legal wire locations, contract condition text and unique JSON case names.
  Parsed 72 proposed cases (39 hook-side, 33 compaction-side).
- Whitespace: cover-note `git diff --cached --check` and a check of the
  patch's added content passed. The unscoped Git whitespace check flags 21
  standard single-space blank context markers in the embedded unified diff;
  those markers are intentionally retained, not trailing spaces in target files.
- No provider conformance, Rust build or TS typecheck claimed: this is a
  contract/vector draft, with no implementation or package changes. AFT has
  no authoritative diagnostic producer for these Markdown/patch artifacts.

Commons remains untouched. No live stores or configuration were opened,
read, written or migrated.
