# Exact TypeScript tool-surface fixture

`generate.ts` calls the shipped OpenCode TypeScript factories and
`buildMagicContextSection`. Dependencies are construction-only throwing stubs;
no database or live store is opened. Zod schemas use the plugin's actual
`normalizeToolArgSchemas` conversion. Only the root `$schema` annotation is
omitted, as in the plugin's converter. Rust compares descriptions as UTF-8 bytes
and schemas as JCS bytes. The single explicit exception is
`ctx_reduce.drop_requiredness`: Rust requires `drop`, while the TypeScript
builder wrongly advertises it as optional. No other field, bound, enum, union,
default or parameter text is normalized away.

The golden's `known_divergences` array must contain exactly that named entry,
with TypeScript's `required` absent and Rust's `required: ["drop"]` present.
The parity check asserts both sides before omitting only this difference from
the comparison. It fails if the divergence disappears on either side, changes
shape, or any other field diverges; it also rejects an empty or expanded
allowlist. Negative controls cover a fixed TypeScript builder, an optional Rust
schema, extra required/root keys, a changed drop type and additionalProperties.
TypeScript's builder is wrong and will be changed to `required: ["drop"]` in a
separate task. Execution already refuses a missing drop.

## Generate and verify

From the repository root, with locked dependencies installed:

```sh
bun crates/mc-module/testdata/tool_surfaces/generate.ts
bun crates/mc-module/testdata/tool_surfaces/generate.ts --check
bun crates/mc-module/testdata/tool_surfaces/generate.ts --check --report-icu-drift
bun crates/mc-module/testdata/tool_surfaces/generate.ts --refresh-assets
bun crates/mc-module/testdata/tool_surfaces/generate.ts --refresh-legacy-facades
bun crates/mc-module/testdata/tool_surfaces/generate.ts --review-baseline=b62632c1a49f4fc248120147aafc0520ef462178
```

`--refresh-assets` updates only the five catalog schema structures and generated
ICU name map, preserving the gateway-required `required: ["drop"]` exception;
it does not change any TypeScript source. Running
`generate.ts --review-baseline=<commit>` emits
`advertised-deltas.json`, the exact before/after schema and string list for
THALAMUS coordination. THALAMUS rejected the optional reduce advertisement:
its Claude Code authority gate requires exactly four schema keys, including
`required: ["drop"]`, or reduction silently becomes unauthorized. The optional
advertisement from commit `4d12af3c` is reverted. ck-mc retains its original
authorization digest:
`69c7dd3393dc8af19386eb80f849df7a1943126bfe1a14769bfff1182b88abf6`.
The delta manifest records the known divergence separately, not as a changed
Rust advertisement.

`--refresh-legacy-facades` writes the two MC-only `broca-facade-tools-*.json`
arrays, the legacy `guidance.get`/`manifest.get` reply pins, and three guidance
references from the real TypeScript factories and prompt builder. It preserves MC's
transport order, execution modes, date/hash envelope and the required-drop exception.
It never runs Rust to produce expected text or schemas and never changes the joint
Broca/commons transcripts or exchanges. Its flags match the legacy test configuration:
memory, temporal markers and smart notes on, no configured Dreamer. Before/after
advertised JSON fields and file hashes are recorded in
`docs/reports/train-stack3-advertised-deltas.json`.

The golden captures 20 tool schemas (five tools × full/light × smart on/off),
48,896 guidance cases (all seven boolean switches × full/light × unset language
and all 190 ICU-resolvable two-letter codes), and 768 additional denied-reduce
and custom-guidance cases. The seven mask bits are memory, Dreamer, temporal,
caveman, smart notes, subagent and compaction, in that order. Bounded children
without callable reduce get no guidance, exactly as the TypeScript caller gates
its builder. The standalone composer's head sessions without compaction use the
real no-reduce builder. Catalog heads without compaction or a user override use
the catalog generator's `tools_only/{surface}` render instead: those sessions
have no compaction history or expandable placeholders. The golden separately
captures all 6,112 combinations of tools-only flags, surfaces and languages;
the Rust parity test checks 12,288 catalog cases against those exact bytes and
asserts they differ from standalone no-reduce guidance. User overrides still
replace the head section, and non-compacting workers still get no guidance.
Tools served by the catalog's role filter are each compared to their real
builder, except for the non-compacting `ctx_search` description captured from
the catalog generator. That description promises plain search hits rather than
compaction-aware filtering. Serving-role membership itself is not inferred from
a standalone TypeScript factory.

The string fragments are lossless interning of actual generator output, not
rewritten expected text: each case stores prefix/suffix indices and the Rust
test concatenates their exact bytes. The generator first composes every full
string with the real builder or the catalog generator's tools-only renderer.
Interpreting the fixture never calls the Rust
renderer to calculate an expected value. Existing guidance text assets also
compare directly against the TypeScript golden.

The canonical capture is Bun 1.4.2 / ICU 78.1 on macOS. Regeneration requires
that runtime. Linux's Bun 1.4.2 carries ICU 78.3 and actually differs in 17 names;
these are listed completely in `icu-drift-and-ts-follow-up.md`. The integration
owner chose the macOS snapshot as the one static contract, not OS-dependent
tables: host ICU variation is a TypeScript defect to fix separately, not a new
Rust config variant. `--check` verifies that the generated production table
equals the independent committed capture, plus 20 live tool schemas and 1,024
no-language/override outputs from the real TypeScript builders. It never uses
live ICU names as the static-table oracle. Rust's complete golden comparison
still checks all 190 language directives and all 48,896 matrix cases. The old
Rust content-language table already matches the canonical names, so the baseline
review manifest records zero changed language strings. Catalog preflight text
revisions now include the generated map so future name changes cannot be
invisible to the cache identity.

Linux verification (request four vCPUs; never execute Rust on macOS):

```sh
cargo test -p mc-module --test parity_tool_surfaces -- --nocapture
cargo test -p mc-module --lib tool_catalog::parity_runtime_tests -- --nocapture
cargo test -p mc-module --lib prompt_surface:: -- --nocapture
cargo check -p mc-module --tests
rustfmt --check --edition 2021 crates/mc-module/src/prompt_surface.rs crates/mc-module/src/tool_catalog.rs crates/mc-module/tests/parity_tool_surfaces.rs
packages/plugin/node_modules/.bin/tsc --noEmit -p crates/mc-module/testdata/tool_surfaces/tsconfig.json
```

The full matrix takes about one to three minutes in an unoptimized Linux test binary.
The five integration tests and five runtime tests passed. Runtime refusal tests
cover missing/blank/non-string drop, oversized note content/condition, memory
content/reason, search query, memory ID count/nonpositive/fractional IDs, and
negative/fractional expand selectors. The expand check exercises the exact mode
parser used by the facade; other checks invoke actual facade dispatch and assert
both `isError` and the unchanged error text. Paging clamps are not falsely
presented as refusals. Mutation of one character of `guidance_primary.txt`
reddens only `legacy_guidance_assets_are_the_generated_enabled_baseline`; the
other integration tests remain green.

## Serial integration follow-ups (not applied)

All `.patch` files here are exact candidate diffs, **not applied changes**, and
need the integration owner's review, tests and formatting. No `lib.rs`, Cargo
file or TypeScript source is edited by this delivery.

- `lib-guidance.patch` redirects legacy `guidance.get` to the tested composer,
  preserves the date envelope, uses effective memory/Dreamer/temporal/caveman/
  smart-note config, honors configured language plus a request override, and
  returns the selected ordinary-note tool manifest. It adds a validated
  `subagent` boolean; the bridge must populate that from authenticated role
  facts, not agent arguments. Until this patch is applied, the old endpoint
  still serves its fixed enabled assets and has no child variant.
- `lib-primer.patch` adds the exact missing primer source line to the old full
  search helper. Actual startup/session metadata already obtains that line
  from the catalog after this change, so this patch is unnecessary if obsolete
  helpers are removed instead.
- `lib-search-default.patch` changes only execution's default 8 to 10. The
  alternative `lib-search-runtime-parity.patch` also removes the 25-result cap,
  floors positive fractional limits, clamps negative limits to one, and aligns
  the missing-query error with TS: `Error: 'query' is required.` rather than
  `Error: 'query' is required for ctx_search.` Apply one, not both.
- `lib-remove-model-string-caps.patch` removes model-field caps that TS does not
  have: note/memory content 65,536 UTF-8 bytes, note condition/memory reason
  4,096 bytes, and search query 1,024 bytes. It keeps compiled-note transport
  caps. These are security/resource-policy decisions; current refusal behavior
  is deliberately unchanged and tested in this branch.
- `lib-note-paging.patch` addresses TS's uncapped read limit and floor behavior
  for limit/offset. Rust currently caps limit at 100, maps limit zero to one,
  and defaults fractional limit/offset to 25/0; TS maps zero to 25, floors
  positive fractions (including a limit below one to zero), and has no cap.
  Neither implementation refuses these numbers.
- `lib-memory-id-validation.patch` is a primary-ID validation candidate: TS has
  no 100-element primary-array cap or positivity schema/runtime check, and its
  invalid-shape errors are action-specific integer-ID messages, not Rust's
  `positive 64-bit integers` messages. TS get still caps the deduplicated set
  at 20. This patch does not certify downstream storage errors for zero/negative
  IDs, large JS integers, duplicate mutation semantics or integral-float wire
  numbers; those require action/storage differential fixtures before cutover.
- `lib-expand-positive-domain.patch` aligns the mode parser's positive-ordinal
  checks/error copy and null-message handling with TS. Rust currently accepts
  ordinal zero and reports `non-negative`, while TS uses `positive`. **Do not
  apply without the agreed authenticated ordinal-base translation**: changing a
  minimum does not convert native zero-based archives into one-based archives.
  Integral-float wire values also need separate resolver fixtures.
- `lib-obsolete-metadata-cleanup.patch` removes eight now-unused private metadata
  helpers and redirects their two old schema checks to actual advertised tools.
  This resolves the `dead_code` lint errors caused by consolidating schemas.
  The existing native-zero execution assertions remain unchanged; only their
  advertised minimum assertion changes to TS's number/no-minimum shape.
- `catalog-generator.patch` updates the older design/example generator's
  noncompacting-head selection and text-revision language map. After applying it,
  run `bun docs/designs/mc-tool-catalog-v1/generate.ts` to regenerate its pinned
  answers and config text revision. `catalog-tests.patch` updates the two
  out-of-scope assertions for no-reduce head text and primary override ownership.
  The changed override test's meaning is explicit: a primary override now owns
  head prose whether or not MC compacts the session, as the real TS builder does;
  children still ignore it.

The old catalog regression selection currently reports four expected failures:
`a_user_override_replaces_only_the_compacting_head_text`,
`every_example_request_gets_exactly_the_pinned_answer_bytes`,
`every_role_and_compaction_cell_serves_its_exact_tools_and_text`, and
`tool_catalog_over_the_route_serves_the_pinned_bytes` (22 pass in that run).
The separately rerun `text_revision_is_the_one_config_json_records` also fails
after adding the ICU table to the revision: expected revision
`ed57523e4298f1ab7644ca0552947eea8554945e06f113b5a172eab44063ce00`, actual
`e96462779e2338331a8d73f65d25263e2484e7477eaa59821877434987b1cfdb`.
Regenerate the pinned fixture with the supplied generator patch; this is not a
TypeScript text change. Strict all-target clippy
fails only on the eight obsolete root helpers; the narrower clippy run with
`-A dead_code` passes. Package `cargo fmt --check` also has an unrelated existing
format difference in `transform.rs`; all three owned Rust files pass direct
Linux rustfmt checks. These integration follow-ups are not hidden by weakening
the independent new parity tests or by rewriting out-of-scope files.
