# Host runner contract extensions — SUBC / BROCA / ALF

## Status and merge gate

This note requests item-by-item disposition from SUBC, the contract owner, and
compatibility review from BROCA. ALF owns the Magic Context integration. It is
not an amendment to commons and does not authorize implementation of the pending
extensions. Only OpenCode 1 (`opencode`) and OpenCode 2 (`opencode2`) are in scope;
Pi and OMP keep their existing paths. Rust mode never requires Broca to run.

The four earlier SUBC rulings below are **landed**. The four new fields and four
D1.6 departures are **pending SUBC disposition**. The integration owner's delivery
instruction is to preserve that truthful state and take this note to SUBC and
BROCA for rulings. No supplied evidence establishes approval of the eight new
items. Lenient decoding is not semantic acceptance.

**M3 and M4 merge gate: CLOSED.** Before either merges, record SUBC's disposition
of each P1–P4 and D1–D4 item in the ledger, with response provenance and any
conditions. A pending item is not approval. A rejection or conditional response
that changes the reviewed design must be resolved by ALF with the owners before
the dependent implementation merges. Record BROCA's compatibility response too;
the checks below are requirements for later slices, not claims of executed tests.

| Item | SUBC disposition | Response provenance / conditions | Broca ignores it check |
|---|---|---|---|
| L1: hook ingest identity and message | Landed | Reviewed spec, Contract rulings §1; commons `544d2d249c789fc9c871501eacf491bd548b57c2` | B-L1 below |
| L2: `descends_from` | Landed | Reviewed spec, Contract rulings §2; same commons commit | B-L2 below |
| L3: `coverage` | Landed | Reviewed spec, Contract rulings §3; same commons commit | B-L3 below |
| L4: step `detail.history_gap_from` | Landed | Reviewed spec, Contract rulings §4; same commons commit | B-L4 below |
| P1: `served_through_ordinal` | **Pending** | No owner response supplied | B-P1 below |
| P2: `unserved_subjects` | **Pending** | No owner response supplied | B-P2 below |
| P3: `subject_part` | **Pending** | No owner response supplied | B-P3 below |
| P4: `pass_complete` | **Pending** | No owner response supplied; `state_sync` use is MC-internal | B-P4 below |
| D1: capability admission | **Pending** | No owner response supplied | B-D1 below |
| D2: observation | **Pending** | No owner response supplied | B-D2 below |
| D3: paging and `wait` | **Pending** | No owner response supplied | B-D3 below |
| D4: status content | **Pending** | No owner response supplied | B-D4 below |

## Authority and frozen evidence

The authority is the [reviewed campaign spec](../specs/ct_00000000-0000-41b8-98dc-36ef49802db8.md),
especially M0 and the M3/M4 dependency (lines 85, 96–117, 160), D1.4–D1.6
(271–283), D2.3–D2.7 (315–366), D3.1–D3.2 (396–421), D3.8–D3.10 (443–453),
the landed rulings (495–501), and direct-caller authorization (505–511).
The original host-adapter draft is superseded and is not an authority here.

All contract and implementation evidence was read from the worktree's frozen
copies, never from a foreign checkout. The [manifest](../evidence/slice/manifest.json)
records source roots, revisions, paths and selected ranges. In the citations below:

- **H** is `crates/cortexkit-role-step-transform-provider/CONTRACT.md` under
  `../evidence/slice/.athena-evidence/98294c61a4f3c5fa8ce025385e5f10dd6e57c5f55dd747e9129109160e3682d3/`.
- **C** is `crates/cortexkit-role-compaction-provider/CONTRACT.md` under the same
  frozen prefix. Both are complete copies from commons
  `c1591d4a76fa3d3a7367237922b0bca5214dbf11`.
- **MC** paths are under `../evidence/slice/`, frozen from Magic Context
  `727ee8859237f270c5639310d7128b85e2ad5fe7`.

The spec records the earlier rulings as landed on commons master at
`544d2d249c789fc9c871501eacf491bd548b57c2`, with both provider crates at 0.1.1
and all four CI jobs green. That CI statement is the spec's recorded evidence,
not a CI run performed by this documentation slice. The later frozen contracts
corroborate the optional-field shapes. They do not establish approval of P1–P4
or D1–D4. M1/M3 own their dependency pin; this note changes no dependency.

## Compatibility and admission envelope

The host uses existing operations over `{method: string, params: object}`:
`transform.declare`, `transform.hook`, `compaction.setup`, `compaction.step`.
There is no new transform op or `compaction.ready` endpoint on a host plugin.
Setup is recorded once per conversation; later descent is not a second Setup.

The conversation key remains `(project_root, session, harness)`. Host plan items
use `preset: "head" | "worker"` and opaque params including
`{serializer_profile: "opencode-aisdk", observation: "answer"}`. The same frozen
params are passed on declare, Setup and hooks. Params select behaviour, not
identity; a caller cannot select another conversation by changing them.

H §10 (450–469) and C §15 (577–595) require unknown fields to be ignored.
Optional members are omitted when absent; the new proposals below likewise use
omission, not a new `null` sentinel. Existing strict discriminants (`hook`, `op`,
`answer`, `on_unavailable`, etc.) stay strict. Unknown fields being decodable
does not make an older ck-mc safe for the host lane: it would ignore the
acknowledgements on which promotion, burns and barriers depend.

All proposed host-only semantics are selected by `params.serializer_profile:
"opencode-aisdk"`; the answer-observation departures additionally require
`params.observation: "answer"` and host admission. `owned-broca` and absent host
params retain today's path. In particular, D3.10 leaves Broca's declaration,
tag/cadence lanes, subject identity and observation unchanged. The frozen Broca
declaration is `pre_user: [append]`, `post_tool: [prepend, append]`, and, when
the composition makes MC the reduction owner, `post_assistant: [replace]`, all
with `on_unavailable: "pass"` and budget 1,500 ms
(MC `crates/mc-module/src/providers/step_transform.rs:11–34`). The widened host
declaration is not a global change.

## Four landed SUBC rulings

### L1. Hook ingest identity and opaque message

- **Wire:** optional `subject_mid: string`, `subject_ordinal: u64`, and
  `message: JSON value` at the top level of `transform.hook` params (`HookCall`).
  `message` is the whole pre-op ingest message, not an ops-modified clone or a
  JSON string containing the message. OpenCode supplies `{info, parts}`.
- **Admission / absent meaning:** mid and ordinal must appear together;
  `message` requires both, including when its JSON value is explicitly `null`.
  Violations refuse `invalid_params` with `detail.field` naming `message` or
  the missing identity member. The absent trio leaves old bytes and behaviour
  unchanged. The provider interprets `message` only with a recognized
  `params.serializer_profile`; when it needs the message but cannot read that
  profile, it refuses `invalid_params {field: "params.serializer_profile"}`
  (the misconfiguration described by H §7), rather than guessing a codec.
- **Why:** every hook on a mid supplies the same ingest bytes. Ingest is at most
  once per `(lineage, subject_mid)`, across retries and module crashes. A held mid
  with a different ordinal or different raw message bytes refuses
  `invalid_params {field: "subject_mid"}`. Parsed JSON equality is not byte
  equality. The host design also refuses another mid at a held ordinal with
  `field: "subject_ordinal"`; a conflicting step entry uses `field: "messages"`.
  Neither conflict may be silently ignored or overwritten.
- **Lenient decode:** each member defaults to absent and is omitted when absent;
  older peers ignore the extra fields. Source: H §7 (329–368), §10 (465–469).
- **Broca ignores it — B-L1:** preserve the no-field Broca request/answer byte
  vectors and ingest count. Exercise older/lenient decoding with all three
  optional fields and assert the known subject is unchanged; pairing validation
  is a separate check, not a license for a new provider to ignore malformed
  supplied identity. Required negative vectors cover each missing pair member
  and a byte-different repeat. BROCA need not send host messages to adopt this.

### L2. Explicit lineage descent

- **Wire:** optional `descends_from: {lineage_id: string, through_ordinal: u64}`
  on the first `transform.hook` of a new lineage and on `compaction.step` params.
  The object names a lineage in the same conversation. Its prefix is inherited
  through the ordinal inclusively, retaining message ids and ordinals.
- **Admission / absent meaning:** absence declares no inherited history. A
  present object requires both typed members, with unknown nested fields ignored.
  A provider must hold the declared prefix; it cannot infer ancestry. For the
  reviewed host design an unsatisfied step answers `refuse` with
  `code: "history_unreadable"` and the known first missing ordinal; a hook answers
  ERROR `transient` with no gap detail. An unrelated new lineage is not admitted
  as a guessed descent.
- **Why:** revert and module-ahead recovery continue the durable prefix without
  re-ingesting it or applying a second Setup.
- **Lenient decode:** the object defaults to absent and is omitted then.
  Sources: H §7 (369–380), §10; C §6 (213–220), §15.
- **Broca ignores it — B-L2:** absent-descent Broca vectors remain byte-identical;
  older decoders ignore the object and nested unknown fields. A newer provider
  must still honor a descent BROCA deliberately sends. The host-only recovery
  must not silently create ancestry for a Broca conversation.

### L3. Applied-view coverage

- **Wire:** optional `coverage: {end_mid: string, ordinal: u64}` beside
  `compaction` on a `compaction.step` answer with
  `answer: "compaction_message"`. It is not inside the CompactionMessage and
  is not a Setup extension.
- **Admission / absent meaning:** both typed members are required when present.
  Absence leaves view handling unchanged. Coverage never changes `range`, the
  request fence, version rules or structural checks. The host moves its local
  marker to `end_mid` only after the answer applies, never for a late, superseded
  or otherwise unapplied answer.
- **Why:** the OpenCode marker needs the published boundary id without a store
  ordinal-resolution pass.
- **Lenient decode:** absent coverage is omitted; unknown answer fields and
  nested coverage fields are ignored. Sources: C §7 (285–303), §15 (590–595).
- **Broca ignores it — B-L3:** decode answers with and without coverage (and a
  future nested member); BROCA's applied replacement/range and fence outcome
  must be identical because it does not need a local trim marker. The host's
  rejected/late-answer control must not move a marker.

### L4. Step history-gap detail

- **Wire:** optional `detail: {history_gap_from?: u64}` on a step
  `answer: "refuse"` with `code: "history_unreadable"`, alongside the existing
  `request_id`, `reason` and optional `provider_code`.
- **Admission / absent meaning:** the hint is meaningful only for
  `history_unreadable`, and only when the provider knows the first missing
  ordinal. Absent detail or absent `history_gap_from` supplies no resend hint;
  it never means ordinal zero. On other codes the hint is ignored, and it
  never changes the code's retryability or the rule that a step refusal ends
  the run without adding model history.
- **Why:** the host can retry status from the known missing ordinal instead of
  reading the whole history or guessing a gap.
- **Lenient decode:** detail and its member are optional/omitted when absent;
  unknown detail members are ignored. Source: C §11 (459–465), §15.
- **Broca ignores it — B-L4:** with/without the hint, BROCA still records the
  same refusal code and applies the same retry classification; a hint on a
  non-history code has no effect. Unknown detail members must decode.

**Evidence distinction:** the reviewed spec's L4 is a step-only resend hint, and
D3.9 requires hook ERROR `transient` without gap detail. The frozen H §7 and
§9.1 also permit an optional `detail.history_gap_from` on a hook's `transient`
history refusal. That broader commons permission is not removed here: the host
implementation uses the narrower reviewed behaviour. It must not convert a
hook ERROR into the step's `refuse` answer or broaden step retryability.

## Proposed fields — all pending SUBC disposition

The following are proposed optional siblings in request params, not new answer
variants. Their absence preserves the legacy path; it does not provide proof
that a host served an answer. SUBC must rule on the semantics as well as the
shapes. BROCA compatibility checks deliberately exercise both omission and
extra-field decoding. ALF must not rely on mere decode success for cutover.

### P1. `served_through_ordinal`

- **Wire:** `served_through_ordinal?: u64` on every host `transform.hook` and
  `compaction.step` request; no new answer member.
- **Absent meaning / lenient decode:** omit when no confirmation is supplied.
  Absence means no ordinal-confirmed promotion from this field, not zero and
  not `newest`. Legacy conversations retain their existing observation. An
  older provider ignores it; host use therefore needs the accepted host lane.
- **Why:** it is the highest ordinal durably committed for serving on the
  call's lineage. Hooks within a pass carry the previous committed watermark;
  a step carries the watermark after that pass's append transaction. A revert
  clamps it to the revert target in the same durable transaction. The provider
  promotes pending answers only through it, within the current lineage or an
  ancestor's inherited prefix; ancestor pending answers beyond the descent
  boundary burn. A hook answer alone is never evidence of service.
- **Broca ignores it — B-P1:** an `owned-broca` hook/step corpus, with the field
  absent and with a valid extra field, has the same declaration, answer bytes,
  tags and observation as the baseline. No ordinal-promotion lane activates.
  An older decoder ignores the member. Host crash-before-append and revert
  controls must prove uncommitted tags are not promoted (A6/A9).
- **Disposition:** pending; SUBC response/provenance not supplied.

### P2. `unserved_subjects`

- **Wire:** `unserved_subjects?: [{subject_mid: string, hook: Hook,
  subject_part?: string}]` on every host `transform.hook` and `compaction.step`
  request. `Hook` uses the existing strict hook discriminant; the host's entries
  name `pre_user`, `post_assistant` or `post_tool`. `subject_part` is the tool
  part id for `post_tool`, omitted for other host subjects. Lineage comes from
  the enclosing request, not a new per-entry lineage member.
- **Absent meaning / lenient decode:** absent or an empty list names no burns;
  omit the empty list. Unknown fields on the request and entries are ignored;
  recognized entries still require typed identity and a known hook value.
  This does not relax decoding of the existing hook enum.
- **Why:** a timeout may follow a module commit, or one hook on a multi-subject
  message may fail after others succeeded. The host freezes that whole message
  raw and reports every subject, including the answered ones, until one later
  call answers. Burning is idempotent and precedes promotion and cadence.
  Burned numbers never enter `mc_tags` or rendering; a queued reduction on a
  burned pending tag is discarded. A later status can still ingest the raw
  message without resurrecting its discarded hook output (D2.4, D3.2, A9).
- **Broca ignores it — B-P2:** the `owned-broca` corpus with absent, empty and
  nonempty valid extension lists has unchanged answers, tags and cadence;
  no host burn lane runs. Older decoding ignores the list. Host partial-failure
  and timeout-after-commit controls must show all named answers burned and the
  resend list cleared only after an answered call.
- **Disposition:** pending; SUBC response/provenance not supplied.

### P3. `subject_part`

- **Wire:** `subject_part?: string` on `transform.hook` params for a host
  `post_tool` subject. The same optional member is used inside P2's entries;
  there is no top-level `subject_part` on `compaction.step` or its answer.
- **Absent meaning / lenient decode:** omitted means the no-part identity for
  host `pre_user`/`post_assistant`; the host supplies the actual part id for
  `post_tool`. Older providers ignore it. In the proposed host storage identity
  the no-part slot is empty; wire omission is not a fabricated tool part id.
  Broca's existing subject-key algorithm stays unchanged when absent or ignored.
- **Why:** host answer identity is `(lineage, subject_mid, hook, subject_part)`.
  A model's `tool_call_id` is display-only and not unique (H §7, 381–384), and
  a text digest would collide across distinct identical prompts. Two tool
  parts with the same call id and output must keep separate answers; retrying
  one burns only that subject. Their `message` ingest bytes remain identical.
- **Broca ignores it — B-P3:** valid extra part ids on an `owned-broca` hook do
  not change its answer identity, bytes, repeat handling or cadence; omission
  preserves its old vectors. Older decoding ignores the member. Host controls
  cover duplicate `tool_call_id` with distinct part ids and identical user text
  on different mids (A9).
- **Disposition:** pending; SUBC response/provenance not supplied.

### P4. `pass_complete`

- **Wire:** `pass_complete?: boolean`, with `true` on the pass's last
  `transform.hook`. A pass with no hooked append instead carries
  `pass_complete: true` on ck-mc's own `state_sync` request. The latter is
  MC-internal, not an extension of either commons role. It is not proposed on
  `compaction.step` or any provider answer.
- **Absent meaning / lenient decode:** omitted (or false) signals no barrier;
  omit the flag unless true. Older hook decoders ignore it. The legacy Broca
  lane does not begin depending on the flag or wait for a barrier it never sends.
- **Why:** state sync, including the historian model chain, runs before hooks
  and ingest. Only the barrier schedules off-request historian evaluation, so
  it reads the complete pass's ingest and synchronized chain, not a partial
  message set. A missing barrier after unavailable hooks is covered by the next
  pass's barrier. A zero-append chain change still gets an evaluation. This is
  not a serving acknowledgement and must not replace P1's durable watermark.
- **Broca ignores it — B-P4:** `owned-broca` requests with absent/false/true
  flags have the same declaration, answers and historian behaviour; no host
  barrier scheduling runs. Older decoding ignores the member. Host forced
  interleaving tests cover state sync, the first hook of a multi-message pass,
  and the no-append internal-sync barrier (M3/M5).
- **Disposition:** pending for the external hook field; internal-sync use is
  recorded here for coordination, not asserted as commons approval.

## D1.6 departures — all pending SUBC disposition

### D1. Capability admission without runner transcript reads or ready

- **Wire / admission:** no new request field. The existing plan `params` object
  carries `serializer_profile: "opencode-aisdk"` and `observation: "answer"`.
  A `direct` caller is admitted with an empty runner-group set and no
  `compaction.ready` service only for the bound `opencode`/`opencode2`
  `(project_root, session, harness)` conversation. Without the opt-in or host
  binding, this exception does not apply. Body fields alone confer no authority.
- **Why:** host plugins cannot serve the contract's runner callbacks. Today
  MC `crates/mc-module/src/providers/mod.rs:24–25` requires `transcript_reads`,
  while C §3 (103–108) makes `compaction` an all-or-nothing runner capability
  including `compaction.ready`. This is a semantic admission exception, not
  an unknown-field decode change.
- **Boundary:** runner/Broca transcript reads and other sessions remain
  reserved. A direct caller cannot act on a session it did not bind; cross-session
  requests refuse by name. Local direct callers currently have the trust of
  full-request `transform`, not attested identity. The reviewed spec accepts
  that local risk until caller attestation lands; this proposal must not enlarge it.
- **Broca ignores it — B-D1:** keep Broca's existing runner-group and ready
  admission checks. A runner lacking `compaction` still fails plan admission;
  missing `transcript_reads` does not become generally acceptable. Test admitted
  bound host direct calls and denied unbound, other-session and runner-targeting
  direct calls (M3). Do not globally publish empty runner requirements.
- **Disposition:** pending; SUBC response/provenance not supplied.

### D2. Answer observation instead of `session.read`

- **Wire / admission:** the existing frozen `params.observation?: string`
  selects the proposed value `"answer"`; this note adds no closed observation
  enum. For an admitted host conversation, P1 and P2 on hooks/steps report
  durable service and discarded subjects. Absent observation does not select
  answer mode, and an unrecognized value grants no host exception. The host
  cannot silently fall back to `session.read` if acknowledgement is missing.
- **Why:** the module may have committed an answer the host did not serve.
  Promote-and-burn replaces transcript-based observation, without scanning or
  overwriting prior served bytes. Input ingestion is not answer observation.
- **Lenient decode:** `params` is already opaque and extensible (H §4, §7;
  C §4). Decoding `"answer"` is not acceptance of its semantics. Admission must
  opt into this mode together with the host profile; missing confirmation never
  implicitly promotes pending output.
- **Broca ignores it — B-D2:** `owned-broca` without answer observation retains
  its transcript-based observation and answer/cadence bytes. Extra optional
  acknowledgement fields must not switch it to host observation. Host tests
  assert zero `session.read` calls even across restart and bootstrap (M3/M4).
- **Disposition:** pending; SUBC response/provenance not supplied.

### D3. Paging and `wait` without scans or ready callbacks

- **Wire:** existing `compaction.step` status members
  `messages: [{ordinal: u64, mid: string, message: JSON value}]`,
  `after_ordinal?: u64`, `newest?: {ordinal: u64, mid: string}` and
  `more?: boolean`. Existing answers are
  `{answer: "wait", request_id: string, reason: string, bound_ms: u64}`
  or `{answer: "refuse", request_id: string, code: "history_unreadable",
  reason: string, detail: {history_gap_from: u64}}`. No new answer discriminant.
- **Admission / absent meaning:** only an admitted `observation: "answer"`
  host conversation uses this rule. An incomplete lineage answers `wait` only
  when its status has `more: true`; omitted/false `more` means the last page.
  Incomplete final pages refuse with the first known missing ordinal. Absence
  of `newest` means no written message, not a reason to scan a host transcript.
- **Why:** MC currently waits on incomplete lineage, spawns a `session.read`
  scan and later calls ready (MC `crates/mc-module/src/providers/compaction.rs:395–459`).
  The host needs to deliver its own next page immediately with a fresh
  `request_id`, under the same fence, not wait for ready or `bound_ms`. The
  host-mode wait spawns no scan and releases the conversation lock before
  answering. A wait returned to a status without `more: true` is an unavailable
  call, never an automatic re-issue loop. A complete final page may run the step.
- **Lenient decode:** `more` already omits false; C §6/§15 are lenient on status
  fields. This request/answer shape compatibility does not waive C §10's
  ready-or-bound behaviour outside the explicitly admitted host mode.
- **Broca ignores it — B-D3:** ordinary Broca waits still hold the step and retry
  on ready or the bound, with its existing scan/durability rules. Its `more`
  pages must not accidentally activate immediate host retry. Host tests assert
  no scan, no lock retained between pages, refusal for an incomplete final
  page, and no retry on an unexpected wait (M4/H3).
- **Disposition:** pending; SUBC response/provenance not supplied.

### D4. Status content omits messages already hook-ingested

- **Wire:** the existing `compaction.step` status members from D3, with a changed
  host content rule, not a new message schema. `after_ordinal?: u64` is the
  highest contiguous ordinal whose entries all have `ingested = true`;
  `messages` includes only later entries with `ingested = false`, oldest first,
  as opaque pre-op ingest JSON. A missing cursor is the first status, not an
  assertion that the provider holds history. `messages: []` is valid when hooks
  have supplied all entries, and `after_ordinal` then equals `newest.ordinal`.
- **Admission / why:** only admitted answer-observation hosts can omit these
  entries, because ck-mc holds every answered hook's ingest in its durable log.
  `ingested` means every hook of that message answered. A frozen-raw or
  unavailable message remains false and is sent even if some earlier hooks
  already ingested it; ingest-once makes that repeat harmless. The provider
  detects actual gaps from its held history, not from list sparsity, and refuses
  conflicts before promote-and-burn. C §6 (245–270) otherwise requires every
  message after the cursor, with final values. Sparse status is not justified
  by lenient field decoding.
- **Absent meaning / lenient decode:** no optional `ingested` field is added to
  status entries; that flag is host-record state. Existing decoders still see
  the same `messages` schema and ignore unknown members. Omitted host opt-in
  retains the full suffix rule, not a sparse default.
- **Broca ignores it — B-D4:** Broca still sends every message after its durable
  provider cursor using the existing capped paging/final-value rules. The
  `owned-broca` status/answer corpus is unchanged. Host controls assert empty
  status after N fully answered passes, exactly the timed-out message after
  one unavailable hook, and named gap/conflict refusals (A9/A10, H1/M4).
- **Disposition:** pending; SUBC response/provenance not supplied.

## Cross-item limits and disposition handoff

The host's encoded hook and status requests are capped at **3 MiB (3,145,728
bytes)** and never truncated or sent over the cap. All fields count, including
duplicate content in hook `blocks`. The frozen hook contract's optional cap
measures the compact `HookCall`, not its transport envelope (H §7, 358–368);
ALF's host send check additionally budgets the encoded request. The host status
cap is deliberately stricter than C §6's default 4 MiB message-payload cap and
its rule that an oversized first entry is sent alone. A too-large host status
entry exits with `provider_message_too_large`; it cannot loop through pages.
These host limits do not silently replace Broca's existing size policy.

P1–P3 and D2/D4 form the durable promote-and-burn protocol; P4 is only the
historian evaluation barrier, not acknowledgement. D1 and D3 are what permit
this protocol to work without runner callbacks. The request fence, version
high-water, structural checks, Setup-once rule, frozen budgets and
`on_unavailable` continue to apply; none is weakened by an optional member.

For each pending ledger row, SUBC's response should identify **accepted,
accepted with conditions, rejected, or deferred**, quote the resulting shape
and absent-value/admission rule, and name its provenance (owner response id or
contract revision). BROCA should record whether the associated B-* check is
sufficient and any compatibility condition. ALF then updates this note and the
dependent implementation/test requirements. Until those dispositions resolve
all eight items, **M3 and M4 remain unmergeable**. No commons, Broca, Prefrontal
or Thalamus code is changed by this note.
