# ck-mc role catalog update

## Served table

These are the base sets; existing configuration and request filters still apply.
Only `composition.compaction.provider == "magic-context"` means compacting.
Missing compaction or another provider means not compacting; null is malformed.

| Role | Not compacting | Compacting |
|---|---|---|
| head | `ctx_note`, `ctx_memory`, `ctx_search`; existing tools-only text | All five tools; existing primary text |
| worker | No tools; empty text | `ctx_reduce`, `ctx_expand`, `ctx_search`; existing subagent text |
| reader | No tools; empty text | Same as worker |

Aliases, from the one shared definition table: `primary` → `head`, `subagent` →
`worker`, `tools-only` → `head`. They do not imply compaction. An omitted preset
defaults to head. OpenCode and Pi plugin tool/guidance paths are unchanged.
`role.describe` keeps the shared contract's build-only discovery shape.
It now also lists `compaction-provider/v1` (`role.describe`, `compaction.setup`,
`compaction.step`) and `step-transform-provider/v1` (`role.describe`,
`transform.declare`, `transform.hook`), both alpha. The top-level
`runner_groups` is `["transcript_reads"]`. These methods do not enter the tool
list. HELLO adds the two new strings to `capabilities.provides`, with no
capability requirements; the legacy tool-provider role and tools are unchanged.

Example `role.describe` (implementation version varies with the build):

```json
{
  "majors": [
    {"version":"tool-provider/v1","ops":["role.describe","tool.catalog"],"stability":"alpha"},
    {"version":"compaction-provider/v1","ops":["role.describe","compaction.setup","compaction.step"],"stability":"alpha"},
    {"version":"step-transform-provider/v1","ops":["role.describe","transform.declare","transform.hook"],"stability":"alpha"}
  ],
  "implementation_version": "ck-mc 0.1.0",
  "capabilities": [],
  "runner_groups": ["transcript_reads"]
}
```

## Refusal contract for the gateway

- Unknown catalog or call preset: `invalid_request`, message
  `Magic Context defines no preset "<name>"`, detail `{"field":"preset"}`.
  This follows commons 0.5.0 and its unmodified conformance suite. The initial
  brief's `preset_unserved` was superseded by the parent decision to follow the
  shared contract; no new error code was introduced.
- Worker/reader `ctx_memory` call: `unknown_tool`, message
  `no tool named ctx_memory`, detail `{"tool":"ctx_memory"}`.
- Worker/reader `ctx_note` call: `unknown_tool`, message
  `no tool named ctx_note`, detail `{"tool":"ctx_note"}`.
- Role-admitted non-compacting session's `ctx_reduce`: `unknown_tool`, message
  `no tool named ctx_reduce`, detail `{"tool":"ctx_reduce"}`.

The named call refusals use the role's existing code for a tool not served by
the requested catalog. They occur before resolving or mutating the store, even
if Claude Code exposes the head's tool list to its subagents. Tests drive real
write arguments through dispatch, verify the store remains empty after each
helper refusal, and verify head calls write successfully with and without
compaction. Full catalog fetches with a composition retain process-local state
for the session's bound routes; preflight, digest-only and failed fetches cannot
replace it. A call carrying a fleet preset before any such fetch cannot gain
`ctx_reduce` by claiming compaction in its own envelope. Calls with neither a
preset nor a frozen catalog retain the legacy path regardless of the route's
declared role versions.

### Legacy Claude Code bridge

Read-only inspection of subconscious `crates/subc-mcp/src/main.rs` (checkout
HEAD `1a14993c120725fa1dce7267b6e7d0823835930c`) confirms:

- `open_provider_route` calls `open_route`, whose `RouteOpen` sets
  `role_versions: None` (line 2700). The bridge does not currently declare
  `tool-provider/v1`. This absence is no longer a requirement for legacy calls:
  declaring the role alone cannot switch admission to a non-compacting head.
- `route_tool_call_request` carries `preset: None`; the protocol serializer
  omits absent presets. A planless MCP call never asserts compaction.
- MCP `list_tools` reads `state.exposed_tools()`. These originate in subc's
  control-plane `catalog.list` manifest roles: `desired_session_from_catalog`
  clones `ProviderRole::ToolProvider.tools`, namespaces the names, and preserves
  each schema. `mcp_tool_from_exposed` copies the schema object into MCP
  `inputSchema`. It does not call Magic Context's `tool.catalog`.
- Magic Context's startup `manifest` uses
  `prompt_surface::module_tools(PromptSurfaceSelection::default())`. This path
  is unchanged, still advertising `ctx_reduce` with the legacy schema along
  with the other facade tools (subject to bridge policy).

Existing Broca facade goldens already pin the legacy full/light arrays and
their equivalence to the startup manifest. The additional
`legacy_bridge_startup_ctx_reduce_schema_bytes_are_pinned` test pins the exact
startup reduce schema serialization, including description bytes, against an
independent literal. `planless_calls_keep_legacy_response_bytes_even_on_a_v1_declaring_route`
drives a Claude Code-profile transform to mint valid tags, then executes
`ctx_reduce`, `ctx_memory` and `ctx_note` without presets or a catalog. All three
succeed on a v1-declaring route, including real memory/note writes, with responses
byte-identical to a legacy non-declaring route. An omitted call preset still
cannot bypass an already fetched non-compacting catalog.

**Runner catalog durability:** the admitted catalog is also recorded in
`store.db` and runner-bound tool routes consult it after a restart. Preflight,
digest-only and failed catalog fetches still cannot replace it. Compaction and
hook records are keyed by the bound project, trimmed handle and required caller
`harness`; Broca binds routes with `harness: "runner"`. A tool route joins only
a known, unambiguous handle and never asks the Thalamus gateway to resolve it.
The provider tables are installed by store migration 65 and classified as
session-owned shipping state in the move inventory. Provider code lives in
`crates/mc-module/src/providers/`; its record adapter uses mc-store's main
connection and fenced transactions. The store's `synchronous=NORMAL` policy is
unchanged: the fault cuts promise survival of a provider process kill, not a
separate host power-loss synchronization guarantee.

### First catalog fetch and startup ordering

The SDK's `serve_with_handle` awaits HELLO_ACK and `on_hello_ack` before starting
its frame loop. `McHandler::on_hello_ack` starts `StoreOpenCoordinator` with
`tokio::spawn`; it does not await the database open. `on_bind` likewise records
the route without waiting for storage. Therefore a first composition catalog
fetch can arrive on a bound route before the store opens and before any transform.

The catalog joins that existing coordinator's bounded request wait. If opening
or persistence fails, it still returns the exact pinned catalog bytes, retains
the in-process admitted tools, and logs/records the persistence failure for the
bound project and session. Later stateful provider calls refuse by the name
`provider_catalog_unpersisted`, even if the open subsequently succeeds, until a
successful full catalog refetch records admission. Digest-only and preflight
probes do not clear that failure. The failure marker is process-local when the
store cannot be written; no second database or side file is created.

`src/tests/catalog_startup.rs` drives a fresh `McHandler` through the real
subc-daemon and SDK callbacks. Its startup barrier proves that both route bind
and the first catalog request precede the completed open, compares the returned
bytes to `head-full.answer.jcs`, and covers fresh, ahead-fenced, damaged and
delayed storage. No transform runs in these cases.

Step-hook subscriptions are advisory (`on_unavailable: "pass"`) and declare a
1,500 ms budget, below Broca's 30,000 ms admission cap. Broca freezes applied ops
or an unavailable outcome in the subject's WAL record and never re-runs that
subject. Pending reminders/nudges therefore target later subjects, and MC must
advance applied state only from accepted, durably observed effects. S4 exercises
that WAL acceptance/unavailable integration, including permanent missed edits.

**Deferred guidance sentence:** commons `CatalogRequest` has only `params`,
`preset`, `composition`, `system_text` and `digest_only`. It has no actual
model-visible tool set. `composition.providers` records admitted provider tools,
not a separate shared head visibility set; ck-mc requires its entry to match the
tools it serves. Thalamus HEAD's `guidance_client.rs` still calls legacy
`guidance.get` with `serializer_profile`, `variant` and the single `ctx_reduce`
`tool_present` boolean. Per the parent decision, no new field or warning sentence
was invented. The proposed future catalog argument is `present_tools: string[]`;
agreement with Thalamus is pending. Worker/reader text therefore continues not
to mention `ctx_memory` or `ctx_note`. No schema, migration or epoch changed.

## Digests

Before is Magic Context base `2ea196d0eeaccbdcd8456114716aeadaea067691`.

`text_revision`:

- Before: `688e3ccf33d746625eb3c7002027f74ab0eb5c78e658bfa1175594421a9a8602`
- After: `ed57523e4298f1ab7644ca0552947eea8554945e06f113b5a172eab44063ce00`

The revision moves because the shared definition now includes role-named
guidance templates. Rendered legacy wording remains byte-identical. Every
existing text's `item_digest` is unchanged. `preflight_digest` changes with the
role spelling and text revision; exact values are in each answer JSON.
All structural tool-schema digests remain unchanged, including frozen
`ctx_reduce` at `69c7dd3393dc8af19386eb80f849df7a1943126bfe1a14769bfff1182b88abf6`.

| Example (old → new name) | Before `catalog_digest` | After `catalog_digest` |
|---|---|---|
| preflight | `4dbfd638576261155e2f10b6dddfbd16ba652da5529e8a978b0ca625e2a994f2` | `ad208b282a43a6098e2d6eb68b80cd2bb6dbcdc7c828f6d3c7434e0d26a9e07a` |
| primary-full → head-full | `363be1ae56892bef2904595cf6644ddfbe4144d080d073776069a1f881ab5e4f` | `877bccd25f9710efe0b5a65743b750afd4a55323469376ffc18f6d70158f0a78` |
| primary-full.digest-only → head-full.digest-only | `363be1ae56892bef2904595cf6644ddfbe4144d080d073776069a1f881ab5e4f` | `877bccd25f9710efe0b5a65743b750afd4a55323469376ffc18f6d70158f0a78` |
| primary-light → head-light | `bf46a16344d6869af44648fb17a990aef33746ed46687bdeaa39914b73677a39` | `2fa1f1869f8f43400911e7706d3b4a1c46528c4baf6d82a7a5f9aab6ba856a0f` |
| subagent → worker | `a297c427e1f4e821bb134081d8965f34a30c5abe0a98f2f00196b941de316f55` | `f57c99870f14feda4ba439a75bdf98ed3a47e9ad39241e34a9ceecdb045771dc` |
| no-reduce | `f3fb053c5bbc680734978aee427804ec443a0114eea9a5f417f8e438a6346c62` | `458191e01137c71e379a67ce0c4fbb1caae46d64a0d4f79d7b26422c7977830b` |
| tools-only → head-no-compaction | `460bf7b2b492835d15e29855833f2134a079dac5ab190a48f6f9d6d1c0f0a91b` | `6070f6d414718531de24169d04ea2a8881c602215638f92b0684c2475311d414` |
| tools-only-light → head-no-compaction-light | `1f0295dcc087dac9f7cbd21557d53a35fed395e8560481fdfcccc15bccd7158c` | `9de5b6d68b0e5205019f4dfaf11af3bd62f366dc057ec56b50c2ffcca2d8bce0` |

New examples:

- reader: `36c7f6a71809a49e979c7fbc4a2397a9eb5f19328407cc73b0336fd50dca0011`
- worker-no-compaction: `a5bcb842c26deaabeb137edc971c4662e2779b90a026b93685940e3ca84b2245`
- reader-no-compaction: `eb967d6ca86f5c2bd15394ac10a0ab8345e916cb35804027271974f0ddefc9e5`

Composition digests change only for the compacting examples (the frozen
compaction item, and worker's removal of memory/note tools):

| Examples | Before | After |
|---|---|---|
| primary/head full and light | `1563f27857ccc582af048c3dd534592d635e9e0c7f8d0422f5cec87d7cd54b0d` | `c7dd640f65180d13af85feec11f66b90b7a184ef351485c4e68c7b974be5cb1c` |
| subagent/worker | `14372c934b4cc674d249594bb8d80aea9f8a95f68e3c9f5e733fc42307d625d5` | `ac860a53f337bf8104e39d169582b124baa8f283df83c6873066d7751379892f` |
| no-reduce | `2f77d29093f2e39d962a9c94e5cb4460c57b089eb1481a8cd9fadb7ccb1d1045` | `909d968f1317d3a6118a44c85584f5615fd1cb03f35a71113dce65c8fdf08c4b` |

## Prefrontal `22d9b3dafa95`

Check command:
`MC_CATALOG_PREFRONTAL_REF=22d9b3dafa95 bun docs/designs/mc-tool-catalog-v1/generate.ts --check`.
`PREFRONTAL_REF`'s default remains unchanged (`804ada4d283f244d54c3d06adb3d521fad4aa292`).
The sibling is read-only; vector trees and content are loaded with `git show`.

23 canonical JSON/digest vectors checked: 17 pass, 6 fail plan compatibility
by design. All 23 retain correct JCS/SHA-256 bytes and Magic Context capability
tags. The no-compaction head's composition digest is
`e5d6c646c78f48fe16b1e3f3d1ee8a656f7bbd5447ba6b8b02a4837d44c4d3a7`.
The commons cross-check passes 16 digest vectors; its two floating-point vectors
are skipped by the generator's existing integer-only canonicalizer.

Passing compositions (all 11): `broca-head-no-compaction`,
`broca-head-optional-text`, `broca-head-plexus-direct`,
`broca-head-plexus-no-exclude`, `broca-head`, `broca-worker-unknown-provider`,
`broca-worker`, `pre-tool-declared`, `pre-tool-tightened`, `pre-tool-two-phase`,
`text-only-and-hook-only`. A composition alone has no plan preset to validate.

Passing plans (6): `broca-head-no-compaction`, `broca-head-optional-text`,
`broca-head-plexus-direct`, `broca-head-plexus-no-exclude`,
`broca-head-text-reordered`, `broca-head`.

Failing plans (6):

- `broca-worker-unknown-provider`, `broca-worker`: Magic Context `tool_items`
  preset `worker` without Magic Context compaction.
- `pre-tool-declared`, `pre-tool-tightened`, `pre-tool-two-phase`,
  `text-only-and-hook-only`: Magic Context `step_transform_items` preset
  `worker` without Magic Context compaction.

Each error says to omit that item. The check enforces the rule on actual plan
item arrays, including hooks, rather than only on the two worker filenames.
No Prefrontal file or ref was changed. Our own example check uses
`bun docs/designs/mc-tool-catalog-v1/generate.ts --examples-only --check`:
11 examples, 44 generated files, 512 Rust/TypeScript guidance parity cases.

## Compatibility-fence mutation controls

Both mutations were explicitly marked `NON-VACUITY BREAK`, applied after staging
the live generator, and restored with `git checkout -- <path> && touch <path>`.

- Neutralize the non-compacting helper guard: only
  `fetch-plan compatibility fence > plan refuses non-compacting Magic Context worker and reader items`
  fails (14 tests still pass). During diff: generator, 1 insertion/1 deletion;
  after restore: empty diff.
- Swallow the plan's unknown-preset refusal: only
  `fetch-plan compatibility fence > plan refuses a Magic Context preset it does not serve`
  fails (14 tests still pass). During diff: generator, 4 insertions/1 deletion;
  after restore: empty diff.

In each run the other two fence tests remained green. All twelve role-catalog
tests remained green: the nine `head|worker|reader with no|other-module|magic-context
compaction` cells, `aliases name roles, never select compaction`,
`catalog refuses an unknown preset by name`, and
`compaction is optional but never null or malformed`.
