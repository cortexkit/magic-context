# Magic Context move inventory and confirmed protocol deviations

## Inventory boundary

`crates/mc-store/src/move_inventory.rs` pins inventory version **3**, context.db
schema **96**, and store.db schema **65**. Its explicit table/column census was
generated from `initializeDatabase` followed by `runMigrations` on a new context
database, and `McStore::open` on a new store database. The census uses
`sqlite_master` plus `PRAGMA table_xinfo`, not historical `CREATE TABLE` text or
the pre-single-store schema. It contains **107 context tables** and **39 store
tables**, including FTS virtual tables, their hidden columns and shadow tables.
Store migration 61's dropped domain tables are absent. Context's still-present
legacy authority/mirror tables are explicitly `not_session`, not shipped.

This module is deliberately standalone/path-importable. Wiring it into mc-store
and the exporter belongs to the move API implementation. The exporter must call
`validate_schema` on **both capture read transactions**, before reading row data
or admitting any record, and separately enforce the pinned schema versions.
An unknown table, with or without `session_id`, or any unknown column (including
on an excluded table or a generated column) returns
`inventory_unclassified {store, table, column?}`. Discovery never grants shipping.
Missing tables/columns remain schema-version/install validation concerns; this
drift fence specifically detects additions not reviewed by the inventory.

SQLite owns the `sqlite_` namespace: all such tables are fixed `not_session`
exceptions and are never snapshot/render inputs. The census explicitly contains
`sqlite_sequence` in both stores and context's `sqlite_stat1`. `ANALYZE` can add
store's `sqlite_stat1`, optional `sqlite_stat4`, or another SQLite-internal table
without failing the drift fence. `cortexkit_schema_version`, context's
`single_store_state`, and store's `mc_privilege_state` are explicit
`not_session` entries as well. The marker is local consistency evidence, not a
session row to import.

### Session classification

The code is the complete ordered field list; the following records the policy:

| Store | Class | Tables |
|---|---|---|
| context | ship | `session_meta`, `tags`, `pending_ops`, `source_contents`, `tool_owner_backfill_state`, `compartments`, `compartment_events`, `compartment_history_versions`, `session_facts`, `compression_depth`, session-only `notes`, `transform_decisions`, `temporal_decisions`, `session_replay_decisions`, `m0_mutation_log`, `historian_runs`, `recomp_compartments`, `recomp_facts`, `subagent_invocations`, `plugin_messages`, `lkg_slots`, `lkg_slot_chunks`, `session_projects` |
| context | rebuild | `compartment_chunk_embeddings`, `message_history_fts` and its five shadow tables, `message_fts_rowid_map`, `message_history_source`, `message_history_index` |
| context | local_reset | `compartment_state_lease`, `synapse_batch_ledger`, `embedding_measurement_corpus`, `user_memory_candidates`, `primer_candidates`, `pending_session_cleanup` |
| store | ship | `mc_cache_state`, `mc_cache_frozen_chunks`, `mc_cache_sections`, `mc_compartment_dates`, `mc_tags`, `mc_tag_cache_generations`, `pending_agent_drops`, `mc_reduce_command_ledger`, `mc_channel1_appends`, `mc_user_hints`, `mc_temporal_marks`, `mc_overlay_frontiers`, `mc_wrapup_commands`, `mc_recomp_commands`, `mc_pass_trace`, `mc_pass_trace_history`, `mc_chunk_transcripts`, `mc_state_imports`, `mc_transform_session_roots`, `mc_served_output_fingerprints`, `mc_block_identities`, `shadow_divergences`, `mc_historian_side_channel_outbox`, `mc_facade_mutation_ledger` |
| store | local_reset | `mc_historian_pending_run`, `mc_single_store_pending_publish` (both must drain to empty before capture), `mc_cache_state_digest`, `mc_dream_task_commands` |
| both | not_session | Every remaining **explicitly named** census entry; not a runtime catch-all |

All 34 `SESSION_SCOPED_TABLES` from the frozen inventory evidence are covered.
Predicates select by session only, across **all** harness values (including
`opencode:rust`); notes additionally require `type = 'session'`. A shadow table
has no independent session predicate: its `ShadowOf` entry delegates ownership
and destination-populated checks to `message_history_fts`. Neither its rows nor
hidden FTS control columns are shipped.

`mc_facade_mutation_ledger` is session-owned despite lacking a column literally
named `session_id`: the facade passes its `conversation_key` as `identity_scope`
to `with_facade_command`. Its predicate is `identity_scope = ?1`. Omitting this
ledger would silently remove command idempotency. `mc_privilege_state` is the
singleton machine privilege/single-store marker. `mc_project_mural_artifacts`
is project-keyed, not session-owned. The other previously undecided tables,
`shadow_divergences` and `mc_historian_side_channel_outbox`, hold `session_id` and
ship; no served-byte equivalence proof licenses dropping them.

Every entry lists columns in `table_xinfo` order and primary keys in PK order.
Store migration 64 retains the agent-move metadata tables. Store migration 65
adds `mc_provider_sessions_v1` and `mc_provider_catalogs_v1`.
Both ship with `session = ?1`, including every project and caller-harness
coordinate of that opaque host session. `project_root` is a preserved key, not
a project-global render input. All columns ship: dropping the record or catalog
would lose allocated versions/tags, frozen admission or unapplied answers.
`shipped_columns` returns only a ship entry's columns minus its explicit deny
list. **No current shipped column is denied**: opaque rendered requests and
replay/decision documents are intentional session state, and this inventory does
not invent omissions that might alter served bytes. The class `deny` and
per-column deny lists are available for reviewed future fields. `credential`
is not an entry in either store: the exporter must never open `opencode.db`.
This slice supplies classification tests, not the later exporter's credential
sentinel or file-permission proofs.

Session-composite keys use `Preserve`. Store-wide surrogate keys (including
context tags, notes, compartment/history/event/run ids and store pending-drop
ids) use `PreserveOrRefuseCollision`: a collision must refuse `key_collision`
before either half is installed. This is the conservative preserve policy,
**not** a claim that remapping is safe. No key is designated `reassign` until
round-trip/collision tests prove it absent from served bytes and enumerate SQL
and embedded-JSON references (e.g. `source_contents.tag_id` and
`pending_ops.tag_id`). `mc_tags` is first in the store inventory so the later
installer can apply its triggers before finalizing the shipped generation.

Context migration 96 adds shipped `lkg_served_markers`, plus
`lkg_slots.served_capture_id` and `input_move_digests`. The latter records canonical
host-input digests without changing the older field-token replay digests. Store.db
stays at 63: both TS and Rust served markers are owned by context.db.

### Render-input closure

Render inputs stay `not_session`: selecting them for a digest never ships
memories. `RenderScope` must reuse the host's
`resolveModuleWorkspaceContext` result, the pass's expiry cutoff and its
workspace fingerprint. It does not implement an alternative identity resolver.
The selectors cover `loadModuleWatermarks` and the data its watermarks describe:

| Table | `render_input` selector |
|---|---|
| `project_state` | Session project, canonical workspace members (their epochs feed the fingerprint), and `GLOBAL_USER_PROFILE_PROJECT_PATH = '__global__'` |
| `memories` | Active/permanent, unexpired rows under `expandedIdentities`; own identities bypass sharing restrictions, foreign identities require `shareCategories`, `shareable = 1`, and project/ecosystem/universe scope |
| `memory_mutation_log` | **All** rows under `expandedIdentities`, without a category/status filter; hidden/expired/deleted transitions still advance the mutation cursor |
| `workspaces` | Workspace row(s) anchored by the session project, including sharing categories |
| `workspace_members` | Every member of those anchored workspaces, not unrelated workspaces |
| `v22_identity_rekey_map` | Aliases whose new identity is a canonical workspace identity, needed to reconstruct expansion and own-identity membership |
| `user_memories` | Active global user-profile content; its version is the global project-state row above |

The digest encoder must include the resolved fingerprint as a separate value,
distinguishing null/no workspace from a fingerprint. `render_input_rowids`
selects rows in primary-key order for a later encoder; it does not yet compute a
digest. Shipped compartments, session metadata and m0 mutation rows already
cover the session-owned watermark inputs. Docs/tool/system/model identity
markers are separate render-identity components, not memory-id watermarks.

## ENGRAM-confirmed dispositions

The frozen protocol snapshot (`agent-move-session-protocol-snapshot.md`, lines
14–19, 44–50, 56–66 and 86–94) remains the starting protocol evidence.
**ENGRAM's decisions relayed by the engineering chair override the reviewed
move spec where the two differ.** In particular, file-path import and a HARD
fold for any memory difference are **not approved**. These are interface/design
pins for subsequent implementation, not APIs implemented by the inventory.

1. **Prepare arguments — approved with an opaque host cut.** Engram owns
   `mcStartOffset` (the mc stream's durable end) and passes it. The host fields
   travel as one verbatim, opaque `hostCut` object, at most **64 KiB**. Engram
   binds its digest into the cut record. `hostInputs` is `{count, digest}` over
   the ordered message-id/digest projection, **never the list itself**. MC
   computes message digests at ingestion so prepare compares without re-reading
   the host transcript. Neither MC nor engram invents a `sessionRef` derivation.
2. **Import transport — changed; release approved.** Import pulls staged chunks
   through engram's
   `session.read {sessionRef, stream: 'mc', cutId, fromOffset}`, restricted to the
   caller's own stream, rather than accepting a records file path. Release is
   idempotent per `cutId`: `seal` on activation, `abort` on move abort, `discard`
   for a conflicting staged import. Capture/staging storage still needs private
   local files. The required engram `session.read` path is not implemented in
   this repository/base; there is no compatibility shim or invented local
   substitute. Engram must provide that path before import integration.
3. **Consistency — approved.** A fence held across **both stores**, recorded in
   the manifest, replaces the removed authority-generation pair. Migration 61
   removed that machinery, so emitting fictitious generations is not a fallback.
4. **Render differences — narrowed; `render_state_mismatch` confirmed.** Only a
   render-**format** difference (another binary's render epochs) forces exactly
   one durable HARD fold, without the LKG or served marker. A different memory
   set or docs does **not** fold: the carried head replays unchanged. Instead,
   imported memory watermarks and memory-mutation-log positions are marked
   **foreign**; m[1] adds **no memory deltas** until the next natural HARD fold
   re-baselines against destination memories. Docs change only on a natural
   rebuild. Every other differing component refuses
   `render_state_mismatch {components}`, writing nothing live. Thus the reviewed
   spec's eager fold for memory differences and unconditional `epoch_mismatch`
   expectation require corresponding later acceptance-test changes, not silent
   reinterpretation. Memory ids remain machine-local until memory sync exists.
5. **Paths — approved with a second check.** Identical repository paths are a
   precondition; absolute operational paths ship unchanged, with MC's refusal
   as a second check. `dir:` project identities remain non-portable and refused.
6. **Embeddings — approved.** Always rebuild embeddings, **never** block the
   first turn on the rebuild; search is degraded until it finishes.

**Surface confirmed:** ck-mc `session.move.prepare`, `session.move.import`, and
`session.move.release` over subc. In production engram calls as
`reserved:engram`. Prepare and release are restricted to that caller, plus a
direct operator caller for development. Every op is idempotent per `cutId` and
returns typed refusals with metadata in error `detail`. Host fences, activation
records, and Broca support remain outside this MC inventory implementation.

### Shared hostCut digest rule (BROCA / ENGRAM / MC confirmed)

The shared combination rule is SHA-256 over, in ordinal order, the UTF-8 bytes
of each message's `mid + "\n" + messageDigest + "\n"` concatenated together.
Each per-message digest is exactly **64 lowercase hexadecimal characters**.
A `mid` containing `"\n"` makes prepare refuse; it is **never escaped**.

`hostInputs` contains the count of messages through the sealed position and the
combined digest. `lastMessageId` is the last sealed `mid`. An empty session has
`count: 0`, `lastMessageId: null`, and SHA-256 of the empty string:
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
`sessionId` is a JSON **object** `{project_root, session, harness}`, not a tuple.

For Broca, `mid` is the message id returned by `session.read`. A per-message
digest hashes RFC 8785 (JCS) canonical bytes of the entry's `message` object
**exactly as served**, excluding `ordinal`, `mid`, and the `tool_calls` dispatch
annotations outside that object. OpenCode and Pi hash their own per-host message
shape inside MC's adapter; the count/ordered-id-and-digest-lines combination is
shared by all hosts. The pinned Broca three-message vector (objects, mids,
per-message digests and combined digest) is pending Broca's commit and must be
pinned byte-for-byte by a later slice; this inventory does not fabricate it.

### Pi frontier projection correction

Pi's current durable LKG hashes native `AgentMessage` entries with reconciled
JSONL entry ids; consecutive `toolResult` entries remain separate. Its tagging
and raw-history views group those results into `synth-user-*`, but that view is
not the persisted replay frontier. Therefore Pi's move `mid` is the native entry
id, not a synthetic user id. This supersedes the reviewed spec's synthetic-id
assumption without changing Pi's replay seams or served bytes. OpenCode and Rust
use the same normalized `MessageLike` inputs their capture sites ingest. Each
host hashes RFC 8785 canonical JSON of that input shape; migration 96 stores
those lowercase-hex digests separately from existing replay digests. The host
adapter supplies exactly the ingestion prefix (excluding its answering assistant)
to `moveInputs`, in transcript order; MC does not sort message ids or re-read the
host database. The move integration must wire `startLkgDurabilityPoll` to its
open sessions' draining fences and stop the timer on host disposal.

### Native-compaction limitation

With `compactionOff`, the host owns the prompt and MC per-turn failures remain
fail-open. Those passes never write served markers, including slot drops. Move
integration must pass the session's current `compactionOff` setting to
`checkLkgDurability`; it returns `certified: false`, even if a previous managed
pass left a marker. Such a move promises no MC prefix identity, omits carried
replay authority, and the importer rebuilds normally. The draining poll reader
must exclude native-compaction sessions, not managed sessions whose last marker
failed.

### Marker availability and the accepted crash window

Move certification is optional and never refuses an otherwise servable turn.
A failed or contended served-marker write returns no id. The normal deferred
LKG save still runs and writes `lkg_slots.served_capture_id = NULL`; an older
marker cannot certify that newer capture. `checkLkgDurability` reports
`certified: false` whenever the persisted slot and marker do not match. The move
then omits carried replay authority and rebuilds normally. A subsequent successful
marker and slot write restores certification, including an unchanged Pi pass
whose previous capture had no certificate. Existing strict history-boundary and
LKG invalidation rules are not weakened by making the move marker best-effort.

A host crash between serving new bytes and the deferred slot save can leave a
stale but self-consistent old slot and marker pair. This window is accepted:
replay uses the old LKG plus the host's newer messages as tail, exactly as a local
post-crash restart does. History is not lost; the first request may incur one
prefix-cache miss. No sidecar file, extra database, or additional fsync is added
to engineer around this accepted window.

**Live-move prerequisite for s3:** wait for in-flight passes and queued capture
callbacks to settle under the draining fence, then have the live owner poll
certify its final in-memory capture. `repairLkgDurability` can write a missing
marker, bind it to that same capture, and re-persist the slot without advancing
`capture_sequence` or changing served bytes. It never hydrates an older disk
slot to invent ownership of final bytes. If either write remains unavailable,
report the move as uncertified and rebuild on import. The repair reader must
exclude frozen/import-gated sessions and native-compaction sessions.

### Pi synchronous marker cost

The worktree-local `target/s2-pi-benchmark.ts` fixture uses 500 native messages
(1,211,756 serialized bytes), 20 warmups and 120 measured passes per mode.
Balanced, alternating before/after capture timings (median / p90, milliseconds)
were **0.484 / 1.882 without the marker** and **0.898 / 4.453 with it**. The
paired added per-pass distribution was **0.292 / 3.975**; timing only the marker
API separately yielded **0.032 / 0.037**. The larger capture tail includes
allocation/GC and runtime variance, not only SQL. A separate-phase run produced
0.441 / 1.157 before and 1.140 / 17.194 after, despite an isolated marker cost of
0.049 / 0.211, which motivated interleaving the fixtures rather than attributing
phase/heap drift to the marker.

An instrumented alternating run measured 0.505 / 2.401 before and 0.739 / 2.798
after, paired added 0.205 / 2.338, marker API 0.036 / 0.156, marker transaction
0.163 / 0.425, and its COMMIT 0.033 / 0.116. Thus the extra p90 is predominantly
outside the measured transaction/id allocation and commit, consistent with
capture allocation/GC and scheduling; GC itself was not separately profiled.
The marker opens its own small transaction. Sharing the deferred payload save
would change certification timing or pull large slot work into the synchronous
path, so it is not a small commit-cost optimization and was not done.

The paying-pass counter advanced the marker to 140 for 140 new-byte captures;
five subsequent unchanged certified captures and five replays left both that id
and `total_changes()` unchanged (850 before and after). A previously unmarked
capture is the intentional exception: an unchanged pass retries certification.
A scheduler defer that refreshes LKG for a new tail is still a new-byte capture
and pays the marker; defer/replay paths that capture nothing write nothing.

## Verification and reproduction

Embedded tests run the actual current Bun migration chain and `McStore::open`
against throwaway databases under the worktree's ignored `target/` directory.
They compare every live table, every `table_xinfo` column and every PK with the
checked-in inventory, exercise all six A2 drift cases, excluded/generated-column
drift and `ANALYZE`, and select independently seeded memory/workspace/profile
sentinels. They also check the live 35-table session list, all-harness predicates,
session-only notes, and facade-ledger ownership.

Until mc-store exposes this module, create an **ignored**, worktree-local harness
at `target/move-inventory-harness/` with this `Cargo.toml`:

```toml
[package]
name = "move-inventory-harness"
version = "0.0.0"
edition = "2021"

[workspace]

[dependencies]
mc-store = { path = "../../crates/mc-store", features = ["test-support"] }
cortexkit-store-types = "=0.2.2"
rusqlite = { version = "0.32", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tempfile = "3"
```

Its `src/main.rs` is:

```rust
pub use mc_store::{McStore, LATEST_MIGRATION_VERSION};
#[path = "../../../crates/mc-store/src/move_inventory.rs"]
pub mod move_inventory;
fn main() {}
```

From the worktree root, with the repository's installed Bun dependencies:

```sh
cargo test --manifest-path target/move-inventory-harness/Cargo.toml
cargo clippy --manifest-path target/move-inventory-harness/Cargo.toml --all-targets -- -D warnings
cargo fmt --all
rustfmt --edition 2021 --check crates/mc-store/src/move_inventory.rs
```

The standalone file needs the explicit rustfmt check because it is not yet in
the library's module graph. When migrations change, obtain a new live census,
review every new table/column's class and ownership, update the version pins and
explicit entries, then rerun the fresh-migration equality and drift tests. Do not
generate shipping policy from a column-name or table-name pattern.
