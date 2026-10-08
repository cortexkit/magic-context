# Issue 632: OpenCode 2 host-history growth and idle folding

Investigation only; no product code or configuration changed. Read issue 632 and its
comment before testing. Tested the real **2.0.22 and 2.0.24** CLI hosts, installed
under the throwaway root. Both were installable. Magic Context was this checkout at
`f451e48d0740517e80b553ea9671e841f54d68e0`, package version 0.45.0, **not a separately
downloaded release**. Its built `dist/v2/server.js` SHA-256 was
`1c4747cc1139b7a45a16c5eafb4bba442d311cec2e757653293836109df242c0`.

## Conclusions

- **The growth mechanism reproduces, but not the reporter's absolute timings.**
  With approximately 0.75 MB primary requests, 25k uncheckpointed rows cost
  1.39–1.59 s per continuation on 2.0.22 and 1.28–2.43 s on 2.0.24 in the final
  captures. A host checkpoint brings that cost back to the bounded range. These
  runs do not establish 11–13 s per step or 20–21 s for the first request.
- **Both versions expose supported plugin `context.session.compact`.** The older
  “HTTP exists, plugin compact does not” record is obsolete for these versions,
  despite upstream issue 49389 still being open.
- **An expired-cache fold can produce one visible rewrite**, with subsequent tool
  steps replaying the entire first request's history byte-identically. A timer
  checking “idle” before calling compact is not, however, an atomic idle-only
  admission. The default compact request **steers at the next step boundary**;
  a deliberate active-turn control compacted between two provider calls and
  changed the warm prefix.
- **`<recent-context>` is real and redundant with some managed tail content**, but
  blindly stripping every matching string is not safe. `keep.tokens: 0` reduces
  it; it **does not reliably remove it** on either tested version. An invented
  hook `recent` field is ignored.
- **Recommendation: adopt changed, not the proposed timer as-is.** Retain the
  host-fold goal and native API, but require an admission/cache-generation fence
  and the existing shared bust permission. Until those are proven, the smallest
  safe operational change is manual `/compact`, with an accurately documented
  `keep.tokens: 0` option. Do not introduce a private HTTP compatibility shim.

## 1. Growth

### Method and what was measured

Machine: macOS 27.0.1, arm64, Bun 1.4.2, shared with other workers. The hosts ran
`serve --hostname 127.0.0.1 --port 0`, with a loopback OpenAI Responses mock and no
live provider. A wrapper imported the **unmodified Magic Context bundle**, timed
its callbacks, recorded actual drafts/events, and registered one constant-result
`probe_step` tool. Four successful tool calls plus a final text response made five
provider calls per measured turn. The final validator checked all **141 live tool
executions succeeded**; there were no unavailable-tool continuations in the final
matrix. The mock reported 180,000 input / 20 output tokens against a 1M model
window. Host auto-compaction stayed enabled; historian, dreamer, memory, embeddings
and temporal awareness were disabled to isolate foreground work.

Each fresh V2 session was seeded **while the host was stopped** with 1,000, 5,000
or 25,000 `session_message` rows: repeated user / four completed tool-bearing
assistant / final assistant / idle groups, with 300-character user text,
1,800-character tool output and 500-character final assistant text. A compartment
covered the old prefix. A completed local checkpoint was inserted near the end,
leaving 542–546 rows after it, at a whole-exchange boundary. The V2 event sequence
reservation was advanced past the fixture, as the V2 importer does. No V1 tables
were used. This **emulates the post-migration projection**, not a fresh execution
of the V1 importer: the brief also forbids writing legacy V1 tables.

For each size: restart and prime; measure with that checkpoint; stop and delete
**only that throwaway checkpoint**; restart and prime; measure unbounded; request
native compaction through the plugin; measure again. The measured unbounded turns
start at **N + 13 rows** because the priming/control turns are retained. The folded
turns start with one idle row after the new checkpoint. Rows and hook messages are
different units: a tool-bearing assistant becomes assistant + tool messages, so
25,013 stored rows reached the hook as 35,730 messages on its first step.

“Plugin” below is wall time inside the registered Magic Context context callback.
“Step” runs from the previous mock response's completion timestamp to receipt of
the next provider request. “Host residual” is step minus plugin time: host loading,
conversion, request construction, tool execution and instrumentation overhead,
**not an isolated CPU profiler measurement**. The mock's stream emission is also
inside this residual; no real model/network latency is being inferred. Columns
are independent medians over the four continuations, not necessarily additive
medians. There is one measured five-call turn per condition; ranges and cold
priming requests are retained rather than discarded.

| Host | Seed rows; actual unbounded rows | Step median (range), ms | Host residual median, ms | Plugin median, ms | First request, warm / after restart, ms |
|---|---:|---:|---:|---:|---:|
| 2.0.22 | 1k; 1,013 | 126 (118–155) | 93 | 36 | 220 / 1,151 |
| 2.0.22 | 5k; 5,013 | 363 (305–435) | 283 | 79 | 540 / 2,487 |
| 2.0.22 | 25k; 25,013 | 1,507 (1,392–1,591) | 874 | 608 | 2,754 / 5,551 |
| 2.0.24 | 1k; 1,013 | 138 (115–212) | 102 | 29 | 163 / 1,921 |
| 2.0.24 | 5k; 5,013 | 352 (285–459) | 286 | 70 | 548 / 3,823 |
| 2.0.24 | 25k; 25,013 | 1,578 (1,284–2,428) | 1,013 | 564 | 1,687 / 5,232 |

The first request after restart includes lazy plugin activation, state loading and
runtime warm-up; do not label all of that history-dependent host time.

| Host, 25k total history | Rows after checkpoint at measured turn start | Step median (range), ms | Host / plugin medians, ms | First request, ms |
|---|---:|---:|---:|---:|
| 2.0.22, imported-shaped checkpoint | 546 | 153 (110–183) | 120 / 33 | 207 |
| 2.0.22, new native fold | 1 | 279 (137–439) | 161 / 111 | 285 |
| 2.0.24, imported-shaped checkpoint | 546 | 200 (171–211) | 182 / 19 | 246 |
| 2.0.24, new native fold | 1 | 84 (65–98) | 57 / 24 | 94 |

The unbounded first requests were 746,669–752,387 UTF-8 bytes across sizes. The
25k folded ones were 477,873 / 477,880 bytes. The fixture's first native fold also
allowed existing Magic Context reclaim to reduce retained tool history, so these
are **not equal-wire-size before/after controls**. The old-checkpoint arm is the
stronger control for isolating the host history window: its wire size is almost
the same as the unbounded arm. Shared-machine noise is visible even in bounded
arms; do not promise 0.4–0.6 s independently of hardware, payload and plugin state.

Native compaction made **zero provider requests** on both versions. Durations at
1k / 5k / 25k were **165 / 423 / 3,770 ms** on 2.0.22 and **174 / 369 / 2,126 ms**
on 2.0.24, including admission and waiting for settlement. That confirms a
non-model fold, not the reported 16-second duration. The checkpoint bounds reads;
it does not delete old history or bound the database's disk size. An uncovered
managed tail may still require substantial plugin restoration after a host fold.

### What scales in the host

Sources were downloaded under the throwaway root at these exact tagged commits:

- `v2.0.22`: `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`.
- `v2.0.24`: `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`.

Paths below are relative to the upstream checkout. The principal read/runner/
conversion files are byte-identical between the tags; version-specific references
are given where offsets differ.

1. **Every step loads active history again.**
   `packages/core/src/session/runner/llm.ts:163–179,188–195` prepares context for
   each continuation; `session/context.ts:163–177` calls
   `SessionHistory.entriesForRunner`. `session/history.ts:28–59` finds the latest
   compatible completed checkpoint. At **`:78–108`** it selects all rows from
   that sequence onward, in ascending order, and **schema-decodes every row**
   with `Effect.forEach`. Without a checkpoint the sequence predicate disappears.
   This work precedes our context hook; our small outgoing prompt cannot undo it.
2. **It converts that history to model messages before our hook.**
   `runner/llm.ts:224–244` calls `SessionModelRequest.baseTranscript`;
   `session/model-request.ts:100–119` calls `toLLMMessages`, whose
   `runner/to-llm-message.ts` converts tools/results, text and attachments.
   Primary request preparation then fires `context`
   (`model-request.ts:421` in .22, **`:408`** in .24), after that conversion.
   Media filtering/image-budget passes run on the hook's outgoing messages
   (`:293` in .22 / **`:280`** in .24).
3. **There is also sizing work.** Host automatic compaction tests a size anchored
   to the last matching provider usage plus estimated text since it, not a row
   threshold (`session/compaction.ts:862–885` in .22 / **`:874–897`** in .24).
   Hence accepted, small Magic Context requests normally keep auto-compaction
   below its ceiling even while raw history grows. The reporter's shorthand
   “keys on sent prompt size” needs this qualification: without a usable usage
   anchor, the host estimates raw transcript before the primary hook, and may
   compact anyway. Row count is not its trigger.

The timings show both host residual and plugin time growing. They do not isolate
SQL decoding versus conversion with a CPU profile, or prove the abandoned upstream
caching patch's reported 5–6.5 s figure. Neither patch nor the reporter's original
store was used.

## 2. Can a plugin initiate compaction?

**Yes, on both tested versions, without HTTP or credentials.** Live setup captured
`typeof context.session.compact === "function"`, and a timer in the probe plugin
successfully awaited `context.session.compact({sessionID})`, then
`context.session.wait({sessionID})`. Each left a completed host checkpoint with
`reason="manual"` and the Magic Context summary, with no model call.

The installed `@opencode/plugin@2.0.22` and `@opencode/plugin@2.0.24` both declare
`compact` in **`dist/promise/session.d.ts:143`** and the Effect equivalent.
Upstream **`packages/core/src/plugin/host.ts:527–568`**, identical in both tags,
projects it at **`:552`**. The promise adapter forwards it through the supported
session endpoint. Our base already capability-checks the required session surface
in `packages/plugin/src/v2/hooks/context.ts:547–576`; the OC2 architecture document
also records the 2.0.22 minimum. Use a capability check, not a version comparison
or a shim for older hosts.

Upstream [issue 49389](https://github.com/anomalyco/opencode/issues/49389) remains
open, but its body explicitly describes `upstream/v2` at `2cdd938152`, before this
projection. Its open status is not evidence that 2.0.22 still lacks compact.

The reporter's HTTP endpoint is also supported: .22
`packages/protocol/src/groups/session.ts:499–515`, .24 **`:498–514`**. Authenticated
`POST /api/session/:id/compact` with `{}` returned **200 and an inbox item** in the
two `zero` arms; waiting produced a completed checkpoint without provider traffic.
Missing credentials and wrong credentials each returned **401** on both versions.
These service processes required Basic authentication as
`opencode:<server password>`; authorization is enforced by
`packages/server/src/middleware/authorization.ts:72–90`. Browser session cookies
are a separate host mechanism, not a plugin credential strategy.

An in-process plugin receives no public server URL/password in its context. A
registered service can advertise them in its own XDG state `service.json`, but
plain `serve`, standalone and ACP need not have that registration (see
`oc2-api-vs-store.md`). Discovery would need to prove the endpoint belongs to this
process, use its credentials, and make **asynchronous** calls; a blocking HTTP
call into the same host deadlocks its event loop. There is no reason to take on
that narrower, credential-bearing path when the native domain works in the
plain-server runs here. Do not scan live config/state files for a password, assume
unauthenticated loopback, or write a checkpoint directly into the host database.

The API's result means **durable admission, not fold completion**. It can return an
existing pending compaction: `session/inbox.ts:204–227` coalesces pending requests.
Log a completed cut only after settlement and verify its actual checkpoint; a
background caller still produces host `reason="manual"`, so its own log must
distinguish an idle fold from a user command.

## 3. Cache safety and turn/fold races

The proposal's justification is sound **only if the cache is still expired when
the fold actually executes**. `cache_ttl` is Magic Context's assumption about the
provider lifetime, not a provider eviction confirmation. Resolve the session's
per-model/provider TTL, including `never`; do not hard-code five minutes.
`scheduler.ts:125–140` measures strictly **greater than** TTL from the last served
response. `inject-compartments.ts:1870–1882` consumes an idle materialization by
comparing that response time with `cachedM0MaterializedAt`. An unfinished request,
aborted attempt or host compaction must not pretend to be a new provider response.

`ARCHITECTURE.md:79–83` requires ride-only mutations, **one bust permission**, and
no independently originated reclaim bust. A host-row threshold is eligibility
for folding, **not a new permission to change a warm prompt**. The idle supplier
currently renders/persists m[0] (`v2/hooks/context.ts:1195–1224,1272–1284` and
`v2/fold/owner.ts:41–64`); it does not run the ordinary transform's pending-operation
drain, heuristic cleanup, m[1] adoption, strip freezing or LKG capture. Those must
still coalesce before the first subsequent provider call. The current shared
postprocess already recognizes an expired-cache rebuild as a hard ride signal
(`transform-postprocess-phase.ts:2138–2181`); use that permission, not a parallel
“host fold allowed” gate.

### First request after expiry

The final 2.0.24 `cache` arm emulated six minutes of idle against `cache_ttl: "5m"`
by aging **both** the latest stored assistant completion and the Magic Context
response clock while the host was stopped, with an older materialization clock.
Aging only `session_meta` is not sufficient: the usage reread restores the host's
newer completion timestamp (`v2/hooks/context.ts:1106–1128`). This is a local-clock
and wire-byte experiment, **not a measured provider cache-hit experiment**.

| Expired-cache path | First provider body | First-request elapsed | Four following calls |
|---|---:|---:|---|
| Normal expired-cache rebuild, no new host cut | 481,794 B | 1,246 ms | Entire first-request history and request settings replay unchanged |
| Native host fold before the next prompt | 418,703 B | 801 ms | Same byte-identical replay property |

These are sequential controlled turns, not identical-store counterfactual clones;
history and recent blocks differ, so the latency/size difference is not a causal
speed estimate for the scheduler. The fold itself made zero provider calls. The
normal path logged `ttl_idle`; the supplied-fold path performed another
`system_hash` materialization in its first primary callback. Thus **one visible
rewrite does not mean only one internal render**: both off-wire preparation and
first-request shaping can run before the sole provider boundary.

The wire check compares the complete first request's `input` array as the prefix
of every later call, plus every non-input request field, without normalizing IDs
or recomputing expected text through the renderer. It is stronger than comparing
only m[0]/m[1]. No second history rewrite occurred during either five-call turn.
Two queued reduction controls remained active/queued because the transform logged
`reasons=protected:1` / `protected:2`; their original `RAW_745` / `RAW_746` content
remained on the actual wire. This **does not prove every eligible reduction or
historian publish drains** across an off-wire fold. Preservation/protection tests
and an unprotected queued-work test remain prerequisites for an implementation.

### What if a turn arrives during a fold?

Two real-host controls distinguish serialization from idle-only scheduling:

1. **Fold already running:** hold the compaction hook, then submit a normal
   prompt. The host admits the prompt into its inbox, but makes **zero provider
   calls while the hook is held**. After release, compaction ends, the prompt is
   delivered and exactly one provider call runs. The user waits for the fold;
   the host does not concurrently send a partially folded request.
2. **Turn already running:** delay the first mock response by 1.5 s, admit native
   compaction during it, then let its successful tool finish. Compaction runs at
   the next boundary **before the second provider call and before execution
   succeeds**. The checkpoint and actual provider prefix change inside that turn.
   The byte-stability check intentionally observes **false** for this control,
   and true for the ordinary/expired/folded turns. This violates the proposed
   idle-only/cache-dead rule if a timer loses that race.

This matches core .22 `session/session.ts:247–264` / .24 **`:246–263`**: compact
defaults to `delivery:"steer"`. The runner consumes controls between steps at
`runner/llm.ts:79–159`; the protocol explicitly documents that behavior. Passing
`delivery:"queue"` can postpone delivery until an input boundary
(`session/inbox.ts:407–423`), but it does **not** assert an expected idle/cache
generation. A queued turn may refresh the cache before a queued fold eventually
runs. Merely calling `wait`, checking an idle event, and then compacting is also a
check/use race. Neither compact API has an “only if idle and response still X”
condition. A `prompt` hook can coordinate ordinary user admission, but is not by
itself a fence for every shell/command/synthetic/resume producer.

## 4. `<recent-context>`

The host itself appends the block when it renders a completed local checkpoint:
**`packages/core/src/session/runner/to-llm-message.ts:303–321`** on both versions.
It is already in the draft before our context callback. Magic Context preserves
that wrapper and substitutes its current baseline into `<summary>`
(`v2/hooks/context.ts:1751–1772`), so the raw recent block survives in current
provider requests.

The host default is **15,000 keep tokens** (.22
`session/compaction.ts:191`, .24 **`:197`**). It serializes recent whole exchanges,
not exactly 15,000 tokenizer tokens: tool outputs are truncated and a user boundary
can expand retention. `splitConversation` / `recentStart` are .22 **`:690–737`**,
.24 **`:702–749`**. The selection is from stored history, independent of the
plugin-supplied summary.

| Condition | Stored recent text, characters / UTF-8 bytes | Added block, including tags/newlines, characters / bytes |
|---|---:|---:|
| Default keep, 1k fixture, either version | 64,128 / 64,139 | 64,165 / 64,176 |
| Default keep, 5k fixture, either version | 65,830 / 65,841 | 65,867 / 65,878 |
| Default keep, 25k fixture, either version | 60,897 / 60,908 | 60,934 / 60,945 |
| `keep.tokens: 0`, 1k fixture, either version | 337 / 337 | 374 / 374 |

The serialized plugin reclaim reminder contains non-ASCII `§` and `·` characters,
which account for the byte/character difference. These measurements support the
reported roughly 60k-character default overhead, not its exact 60,773-character
sample. The block remained identical throughout each later tool-loop request.

**Zero keep is not zero recent.** `recentStart` always leaves at least the newest
entry, then backs up to a user boundary, so the latest exchange can remain even
when the budget is zero. With a long latest exchange the remainder can be large;
the reporter's 154 characters is a small particular exchange, not a limit. It is
reasonable to document this setting as an opt-in **reduction** in duplicate text,
with the latest-exchange caveat. It is not a reliable no-block fallback and should
not be silently written into user configuration. It applies to future cuts, not
to an already stored checkpoint's `recent` string.

**The hook cannot override it.** Installed promise/Effect
`SessionCompactionResult` at `dist/*/session.d.ts:36–41` has `summary`,
`providerState`, `metadata`, `tokens`, **no `recent`**. Core `fromHook` copies the
separately computed recent argument (.22 **`:583–595`**, .24 **`:595–607`**).
A throwaway 2.0.24 wrapper deliberately returned an additional `recent:""` field:
the completed checkpoint still held 64,128 characters and the provider still got
the block. This is not an available compatibility path.

An output-only stripping prototype, applied **after** the unmodified callback in
the 2.0.24 `strip` arm, left the stored recent text intact but removed the block
from the actual provider body. The first folded body was 415,965 B; the complete
first-request prefix remained byte-identical over four continuations. This proves
deterministic stripping is possible on this simple owned fold, **not that a
general regex is safe for production**.

A safe implementation would:

- strip only the host-generated segment of a positively owned **local** checkpoint,
  after successful managed-tail restoration, never arbitrary user/tool text
  containing the same delimiters, foreign summaries, native encrypted checkpoints,
  or the compaction-off path;
- preserve the raw checkpoint identity used by `FoldOwner.observe`
  (`fold/owner.ts:66–113`), and strip an outgoing clone after observation; otherwise
  the edited hash can manufacture `host_rerender` materializations;
- freeze the outgoing result once per admitted fold and replay it, including across
  restart/LKG/generate paths; first adoption on an existing warm checkpoint must
  wait for the same genuine bust permission, not silently change a defer;
- prove restoration of protected user text, tool call/result pairs, attachments,
  reasoning bindings and **errored tool results** before discarding the fallback
  record. Issue 631's error-preservation regression must be covered, not assumed
  solved by this timing probe. A malformed/ambiguous wrapper or failed restore
  must not be handled by a greedy text deletion.

An upstream supported hook `recent` override, if added, would be the smaller and
cleaner way to avoid building the block. It is absent in both tested versions.

## 5. Recommendation and other modes

**Adopt changed; do not approve the four-point proposal unchanged.** The benefit
is real, and lack of plugin compact is no longer an obstacle. The blockers are
cache/admission correctness and preservation, not a need for HTTP workarounds.

Smallest safe design for an automatic version:

1. OC2 only; capability-check native compact and use the existing read-only V2
   reader to count **stored rows after the latest completed local checkpoint**.
   Count once at idle, not by fetching full history on every pass. A row threshold
   can nominate work, with `0` disabling it, but cannot create bust permission.
2. Carry one per-session idle/cache-generation lease containing the last accepted
   response identity/time, resolved model TTL and proposed cut. Cancel stale
   nominations on new work, model/TTL changes, deletion or another completed cut.
   Admit only against an authoritative idle generation; if new work won first,
   postpone until its next expired idle. Once a fold wins, new prompts may queue
   behind it. Do not interrupt a user's turn to recover a timer race.
3. Use `context.session.compact`, bound and asynchronous, with a correlatable inbox
   id. Coalesce the host cut, m[0]/m[1] adoption, eligible reductions/heuristics and
   any first-application stripping into **the one existing expired-cache rebuild**.
   Preserve protected/unsummarized history; do not launch a historian to answer
   the hook or give automatic reclaim its own warm-prefix permission.
4. At settlement, emit one completion line with cut/inbox identity, true rows
   before/after, duration, and the MC reason/expiry generation. Handle duplicate
   admission, failure, restart, and a fold that did not produce a completed cut.
   Test actual provider bytes, not just callback summaries, and race every
   relevant input path. `cache_ttl:"never"` must not arm this optimization.

The present compact API **does not enforce step 2**. A fully general guarantee
needs a supported host conditional-idle admission/cancellation contract, or a
demonstrably complete admission barrier covering all host work producers. Request
that contract upstream rather than pretending `delivery:"queue"` implements it.
Until it exists/is proven, retain explicit `/compact` and document optional zero
keep accurately; do not ship an unconditional background timer. A host-side
incremental decoded/converted-history cache is an orthogonal way to remove the
linear cost without changing prompt bytes, but was not tested here.

Other modes, inspected rather than newly benchmarked in this task:

- **OpenCode 1:** the marker manager writes/advances a real host compaction marker
  at the managed boundary, on the shared materializing/bust cycle; the host can
  begin its window there. It does not need an OC2 HTTP/native checkpoint timer.
  See `packages/plugin/src/features/magic-context/compaction-marker.ts` and
  `src/hooks/magic-context/compaction-marker-manager.ts`.
- **Pi / OMP:** `compaction-marker-manager-pi.ts:36–139` uses host
  `appendCompaction(summary, firstKeptEntryId, ...)`; pending markers drain on
  materializing passes and the model-visible trim runs independently. It retains
  JSONL history, not an OC2 SQL projection. The first-kept-entry/partial-message
  guards matter; do not describe these hosts as doing no bounded-window work.
- **Rust mode:** on OC1 the module boundary becomes a real marker. On OC2
  `v2/fold/boundary.ts:56–127,153–258` records the module boundary in MC storage
  and trims the array **after the host has already loaded/converted it**.
  `v2/hooks/context.ts:1253–1278` supplies the served module baseline for a host
  fold (with a TS fallback if none has been served). Rust therefore bounds module
  work but is **not exempt from this OC2 host cost**. Any host-history optimization
  needs separate module-owned baseline/admission proof; do not render a second TS
  history or assume TypeScript wire observations establish Rust parity. Pi is TS
  only. No Rust performance or real-host OC1/Pi run is claimed here.

## Evidence, isolation and verification

Live-store rule followed, verbatim:

> never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

Root retained at:

```text
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-632/
```

Every host used an allowlisted environment with `HOME`, `TMPDIR`, all XDG
data/config/state/cache/runtime roots, native toolchain roots and the project
inside its own capture directory. `CFFIXED_USER_HOME` was also isolated on macOS.
`OPENCODE_DB=opencode2.db` resolved inside that arm's `XDG_DATA_HOME/opencode/`;
`MAGIC_CONTEXT_STORAGE_DIR` was inside its `XDG_DATA_HOME/cortexkit/magic-context/`.
Before/after every host incarnation, **`lsof -p <host pid> -Fn`** was saved and
checked; the only database families were those throwaway `opencode2.db` and
`context.db` files and their WAL/SHM handles. No live-store snapshots were taken.
No legacy V1 tables were created/written, no V1 conversion was requested, and no
operation on `migration.v1-v2` was issued. The only host fixture writes targeted
V2 projections/sequence reservation and stopped-host synthetic completion times.
Hosts were terminated by their private process groups; their roots were retained.

Final capture directories (earlier pilots are not the reported matrix):

```text
2.0.22-1000-growth-1791397059375
2.0.22-5000-growth-1791397066675
2.0.22-25000-growth-1791397077149
2.0.24-1000-growth-1791397103656
2.0.24-5000-growth-1791397116854
2.0.24-25000-growth-1791397132822
2.0.24-1000-cache-1791397368688
2.0.24-1000-zero-1791397167926
2.0.22-1000-zero-1791397176886
2.0.24-1000-strip-1791397183951
2.0.24-1000-hook-recent-1791397192820
```

Each has `summary.json`, timed `trace.jsonl`, `requests-*.json` with raw provider
bodies, host/plugin logs, isolated configs/databases and `lsof-*.txt`. The root has
`probe.ts`, `probe-plugin/server.js`, `analyze.ts`, `aggregate.json`, exact-version
host installs and upstream source archives/checkouts. Re-run the retained probe
from this worktree with `bun "$ROOT/probe.ts" 2.0.22 1000 growth`, varying version,
size and `growth|cache|zero|strip|hook-recent`; it creates another private arm.
Then `bun "$ROOT/analyze.ts"` validates the latest complete final arm per case.
The probe creates all isolation variables before spawning any host; do not copy
just its `opencode serve` command into an ordinary shell.

- npm 10.9.8: exact-version CLI/plugin/client installations succeeded, 283 packages
  per version, under this root only; no repository manifest or lockfile changed.
- Final real-host matrix: **11 completed arms**, both host versions confirmed by
  `--version` and live plugin `context.app`; **141 successful live tool executions**.
- `bun "$ROOT/analyze.ts"`: **Bun 1.4.2, 467 capture checks passed**, including
  actual provider replay, row windows, zero fold traffic, native surface, auth
  controls, protected-content retention and lsof database containment.
- Earlier pilots exposed harness-only problems: unresolved client import, lazy
  plugin activation before a timer-only request, unavailable `bash` under the
  host's direct-tool surface, and a mistaken assertion that a full/protected drop
  must produce a placeholder. The final runs use successful registered tools and
  validate actual preservation/removal rather than that assumption. No pilot
  stall or rejected tool is represented as a host growth measurement.
- Build/install were supplied as passing worktree preparation. Product typecheck,
  lint and suites were not rerun for this documentation-only change. No claim of
  real provider cache billing, V1 migration execution, Rust/Pi parity, generic
  stripping safety, or historian-concurrent drain completeness is made.
