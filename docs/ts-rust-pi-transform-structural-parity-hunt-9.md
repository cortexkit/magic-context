# TS ↔ Rust ↔ Pi transform structural parity hunt #9

## Method and privacy fence

This hunt executes the live-evidence legs deferred by hunts 1–8. It changes no transform or engine behavior. The enhanced differ runs from the isolated worktree against the operator-authorized host stores and emits only hashes, counts, ordinals, eight-character session prefixes, and byte lengths.

The live snapshot used:

- provider/decision lower bound: `1787833460000` (2026-08-27 12:24:20 UTC), after the hunt-8 deployment;
- hunt-6 engine lower bound: `1787827923000` (2026-08-27 10:52:03 UTC), after the hunt-6 merge/deploy window;
- 897 provider captures across all discovered live auth-dump directories;
- 63 Pi JSONL files scanned; and
- live `sidebar-snapshot` plus `status-detail` RPC reads, bracketed by direct database snapshots where applicable.

Every SQLite constructor used by `--live` is centralized in `scripts/audit-transform-wire-parity-live.ts` as `new Database(path, { readonly: true })`; each handle must also return `PRAGMA query_only = 1` before any evidence query. The Rust Caveman oracle receives live source bytes over stdin and returns hashes and byte lengths only. No database, JSONL entry, provider message, project path, RPC token, or log prose is copied into this report or the repository.

Operator command:

```text
python3 scripts/audit-transform-wire-parity.py --live --date 2026-08-27 --after 2026-08-27T12-24-20 --engine-after 2026-08-27T10-52-03 --per-session 1000
```

## Consolidated verdicts

| Leg | Origin | Verdict | Live result |
| --- | --- | --- | --- |
| 1 | hunt #6 | **FINDING** | bindings, memory embeddings, and commit vectors close; no post-deploy Rust compartment publish exists, so the compartment auto-embed trigger remains live-unexercised |
| 2 | hunt #8 | **CLOSED** | one aged TS session and one aged Rust session preserve ordinal depth order and produce exact TS/Rust bytes at all three depths |
| 3 | hunt #8 | **FINDING** | 546 OpenAI Responses captures exist and pass the structural matrix, but all lack a config-verifiable lane coordinate |
| 4 | hunt #5 | **CLOSED** | two real Pi JSONLs show stable-ID adoption, drained native-compaction markers, and durable m0/m1 bytes |
| 5 | hunt #7 | **FINDING** | TS status matches direct state; Rust status reports `1666` tags while the one matching live store is stably at `8842` |
| 6 | hunts #1–4 | **CLOSED** | all named self-caused bust classes are zero in non-empty TS, Rust, and scheduler windows |

Because this hunt has findings, it is not an honest empty. The standing honest-empty counter resets from **1/3 to 0/3**.

## Leg 1 — hunt-6 post-deploy engine truth

### Live coordinates

| Rust session | project hash | binding | module compartments total / since cutoff | mirrored compartments total / vectorized / since cutoff | active memories total / vectorized / since cutoff | commit rows / vectorized |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `ses_0ad8` | `a743caf0b3d5` | 1 | 206 / 0 | 134 / 134 / 0 | 211 / 211 / 0 | 461 / 461 |
| `ses_08df` | `4e702b3515ab` | 1 | 148 / 0 | 2 / 2 / 0 | 155 / 155 / 1 | 172 / 172 |

The single post-cutoff active memory row for `ses_08df` has a vector row (`1/1`), closing hunt-6 B3. Both expected Rust sessions have session-project bindings, closing B2. All 633 commit-index rows and all 366 active memory rows across the two coordinates have vectors.

**P9-LIVE-ENGINE-COVERAGE — evidence finding, not an observed engine divergence.** Both module and mirror reads return zero compartment publishes after the hunt-6 cutoff. Existing mirrored compartments are completely vectorized (`136/136`), but a pre-deploy total cannot prove the repaired post-transform callback ran. Discriminating rerun: after a genuine Rust historian compartment publish, the module and mirror since-cutoff counts must both increase and the new mirror row's vector coverage must be `1/1`. No engine change is made in this hunt.

## Leg 2 — Caveman on aged live sessions

The persisted runs are ordinal-monotone (`ordering_inversions=0`). The TypeScript production boundary oracle admits exactly one eligible total for TS (`323`) and the Rust persisted counts admit totals `19..20`; every admissible total yields the observed tier counts, so the boundary result is unambiguous even where the total is not.

| Lane/session | ULTRA ordinal range (count) | FULL range (count) | LITE range (count) | boundary verdict |
| --- | --- | --- | --- | --- |
| TS `ses_00fc` | 5439–6160 (65) | 6180–6708 (65) | 6711–7135 (64) | production persisted counts match TS oracle |
| Rust `ses_0ad8` | 6366–6399 (4) | 6400–6411 (4) | 6420–6463 (4) | production persisted counts match TS oracle |

Each cell below is `sha256:byte_length`. The TS and Rust compressors returned the same cell at every depth.

| lane | tag ordinal | persisted depth | shared source | LITE TS=Rust | FULL TS=Rust | ULTRA TS=Rust |
| --- | ---: | ---: | --- | --- | --- | --- |
| TS | 5439 | 3 | `0522f93d841722503fa0f9c98cab50ea6ec9d53a7563d8365c912fdcadbbe0ec:1855` | `5879af1c09159263cb013616fcc58977213ad14deeb05752cc9c9dd79e32121f:1832` | `7497b4e02ab323c2ddfc8a1074255f6f6de84a54387021b7c66a96e629b8956c:1692` | `11ee6af0e80f66bcba52c103f40627223cc231aeacce4741f379445d9cdb9c59:1653` |
| TS | 6180 | 2 | `73c4333cafee5c7b328fab0d002b5b57190646705e7484525ed1c3869875b469:1797` | `c20e859b14f5f6278a22d3d13f5fe43713808ad33b7e07a9bbd5e3e24df8d46e:1783` | `3ea680113c38de9e622ae66ad7aa8a7ea609cbd1eb4bab771162909e8d43c985:1626` | `ca895483356f64156d754b4ab31e73894ca57f3a868edc9fa642f78dc4e51420:1612` |
| TS | 6711 | 1 | `6dcb9eb2ab7cd7b61c8900bd6b9625bea1cd73591f6f771b1ad56b4550521e5c:13` | `6dcb9eb2ab7cd7b61c8900bd6b9625bea1cd73591f6f771b1ad56b4550521e5c:13` | `6dcb9eb2ab7cd7b61c8900bd6b9625bea1cd73591f6f771b1ad56b4550521e5c:13` | `6dcb9eb2ab7cd7b61c8900bd6b9625bea1cd73591f6f771b1ad56b4550521e5c:13` |
| Rust | 6366 | 3 | `01161e6ffe9419f38a07ae2b209522c673cd8e59459320a7d02301a8217b9173:2258` | `fb73f9f01b1a26dbc32fa18dc4b5f97ef23194d160567a400b4d276d5d94a9d3:2249` | `a18d9ea312ee4b1aa3c1de48b67cb930ff762e1825f2979251de6d287164f36e:2072` | `f40a607de1f972ab05c2e0c4d18cd1e0d0622c0292fcc3f5f4573a27f7a4d6c2:2052` |
| Rust | 6400 | 2 | `9c309cf0c45320cd748a66a1179757add85ec00dbc6aa6cd248150d3a5d564bd:270` | `9c309cf0c45320cd748a66a1179757add85ec00dbc6aa6cd248150d3a5d564bd:270` | `fa6bac5552a8273a6724174713553307900939936370f2513d84a6b93332809a:266` | `2107705ae57f050ddc5a768303d0cf1f50af6ef2a2a5fd6bb60f4aedee6e0de1:264` |
| Rust | 6420 | 1 | `84a59970694c4f9f02c9f1a95414271993e00f0df48ba997708d08b034f068e4:1937` | `c445c361eb68ccbd8ace01db771cb0a1f07a81096085383597a0520e3dcce552:1913` | `b68f08df819c8c5383b0f7425efdb4ad45bbc71c2f9d39a2cf30e83b1de79096:1818` | `d0c3a937db4ed2c2057d8037920c7e15ae0ee526d489f7c7398fca89236d4aed:1792` |

All 18 cross-implementation byte comparisons close.

## Leg 3 — live non-Anthropic inventory

| provider/wire family | captures | aggregate bytes | lane-verifiable captures | structural invariant failures |
| --- | ---: | ---: | ---: | ---: |
| Anthropic / Anthropic messages | 351 | 1,056,414,719 | 0 | 0 |
| OpenAI / Responses API | 546 | 48,030,041 | 0 | 0 |
| Bedrock / Anthropic messages | 0 | 0 | 0 | 0 |
| GitHub Copilot / OpenAI-compatible chat | 0 | 0 | 0 | 0 |
| Qwen / OpenAI-compatible chat | 0 | 0 | 0 | 0 |
| OpenAI / OpenAI-compatible chat | 0 | 0 | 0 | 0 |
| Google / Gemini | 0 | 0 | 0 | 0 |
| Moonshot / OpenAI-compatible chat | 0 | 0 | 0 | 0 |

The OpenAI Responses inventory spans six session prefixes: `ses_fbcb` (229), `ses_fbcc` (36), `ses_fbcd` (236), `ses_fbce` (7), `ses_fbcf` (35), and `ses_fbd1` (3). The extended matrix understands Responses `instructions`, item roles, grouped function-call/result runs, prior-response result ownership, reasoning carriers, empty-content behavior, system placement, dropped placeholders, and tool adjacency. It found zero structural invariants in all 546 captures.

**P9-LIVE-PROVIDER-LANE — live coverage finding.** Every recent capture is `unverified` because its served system coordinate does not expose a project root from which the differ can read live transform configuration. Therefore the seven structural families were inventoried, and Responses shapes were checked, but no OpenAI capture can enter a TS↔Rust value-space denominator. Discriminating follow-up: resolve each capture session through a read-only session-project/authority lookup (without emitting the path or full session ID), then rerun the same hashes. Until then, six requested families have zero traffic and OpenAI Responses has traffic but zero lane coverage. Absence of traffic or lane evidence is not evidence of parity.

No window-report ledger file was present at the authorized live location; ledger row coverage is zero.

## Leg 4 — Pi real JSONL

| Pi session | file `sha256:bytes` | messages / stable IDs / parse errors | durable tags / adopted stable IDs / fallback IDs | native compactions / pending marker | m0 `sha256:bytes` | m1 `sha256:bytes` |
| --- | --- | --- | --- | --- | --- | --- |
| `019de471` | `7583761b19abb523bd129262fb0b835bc6b10f60c1d364786b12b7eb95998ce1:167893864` | 39,647 / 39,647 / 0 | 24,728 / 1,729 / 1,245 | 185 / 0 | `01d71b2ee3d6fdf5a28e2d7f92c6b87856050a3ff8a99b2e865b63718c0b561e:214432` | `f7c61a2892fcbf3f59da14a0e5f4caed46ff5ad5b5192ba2cdaae04e4a4658cc:15567` |
| `019e8905` | `778ffff1b32511cd9ab24ac63c6dc39f0f1cd54ae538422e1f366bfc8990601c:55327534` | 12,761 / 12,761 / 0 | 7,733 / 768 / 0 | 44 / 0 | `51d3e59626bf4242416018acc96ac0a6441c988832a8072524babd0b229a1c3a:274623` | `2b0276c2621dab10849474a7df849950a6b1e0c1cabc9a6de1c123ff12077c41:90` |

Both files have real stable entry IDs, no JSON parse error, at least one durable stable-ID adoption, real native compaction entries, a drained pending marker, and non-empty m0/m1 bytes. The first session retains 1,245 legacy fallback IDs; that is migration inventory, not failed adoption, because 1,729 stable IDs are already durable.

## Leg 5 — sidebar/status versus direct live state

The direct values below were stable across the bracketing reads.

| lane/session | field | direct before / after | sidebar | status | verdict |
| --- | --- | ---: | ---: | ---: | --- |
| Rust `ses_08df` | input tokens | 407,934 / 407,934 | 407,934 | 407,934 | match |
| Rust `ses_08df` | context limit | 1,000,000 / 1,000,000 | 1,000,000 | 1,000,000 | match |
| Rust `ses_08df` | compartments | 148 / 148 | 148 | 148 | match |
| Rust `ses_08df` | pending drops | 9 / 9 | 9 | 9 | match |
| Rust `ses_08df` | total tags | 8,842 / 8,842 | not exposed | 1,666 | **mismatch** |
| TS `ses_fbcb` | input tokens | 225,409 / 225,409 | 225,409 | 225,409 | match |
| TS `ses_fbcb` | context limit | 308,000 / 308,000 | 308,000 | 308,000 | match |
| TS `ses_fbcb` | compartments | 0 / 0 | 0 | 0 | match |
| TS `ses_fbcb` | pending drops | 0 / 0 | 0 | 0 | match |
| TS `ses_fbcb` | total tags | 241 / 241 | not exposed | 241 | match |

Context schema is `81` direct and `81` through status in both lanes. The selected Rust store is the only discovered store containing this session (`store_candidate_count=1`), has path hash `9e3836387de3`, schema `50`, and matches four of the five live module fields. The project and RPC-directory hashes are `4e702b3515ab` and `ec57bf156ffa`.

**P9-LIVE-RUST-TAG-STATUS — engine-status finding.** A quiescent direct `COUNT(*)` over the selected live module store is `8842` before and after the RPC read, while `session.status.tag_count` is `1666`. Usage, context limit, compartments, and pending drops all match that same store, so a whole-store routing error is not sufficient to explain the discrepancy. Handoff acceptance: instrument the module's selected store identity with a hash-only coordinate, reproduce one transactionally bracketed status read, and make `load_session_status_snapshot.tag_count` equal the direct count without substituting the context mirror. No engine fix is attempted here.

## Leg 6 — deployed decision-parity window

| authority | rows | decision distribution | materialization reasons |
| --- | ---: | --- | --- |
| Rust transform decisions | 54 | defer 53, error 1 | none 54 |
| TS transform decisions | 376 | defer 374, execute 2 | none 376 |
| Rust scheduler history | 55 | Defer 55 | n/a |

The six repaired self-caused classes are all absent in this non-empty window: `tool_set_hash=0`, `project_docs_hash=0`, `max_compartment_seq=0`, `project_user_profile_version=0`, `temporal_parity=0`, and `repeated_render_config_within_120s=0`. The one Rust error row is decision inventory; it has no materialization reason and does not belong to a repaired self-caused class. This deferred claim is closed.

## Differ changes

`--live` now:

1. discovers live auth-dump directories and inventories Anthropic, OpenAI-compatible, Gemini, and OpenAI Responses shapes;
2. delegates all SQLite access to a Bun helper whose only constructor is read-only and query-only verified;
3. compares live TS and Rust Caveman outputs through the real implementations and checks persisted depth runs against the TypeScript production boundary oracle;
4. reads real Pi JSONLs without serializing message content;
5. discovers authenticated local RPC endpoints and compares status/sidebar fields with direct snapshots;
6. separates provider/decision and hunt-6 engine cutoffs; and
7. emits only coordinate-safe evidence.

The helper's read-only contract and the OpenAI Responses grouping/continuation semantics are covered by the hermetic differ suite. No live JSON result is versioned.
