# The OpenCode 2 adapter

OpenCode 2 has a different plugin API from OpenCode 1: a `setup(context)` entry, per-session hooks that edit a request draft, host-owned compaction checkpoints and no child-session prompt loop for plugins. `src/v2/` adapts the shared transform core to that host, so the same scheduler, tagger, reclaim and history rendering run on both.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/v2/server.ts`: the `setup` entry and its host check; built separately to `dist/v2/server.js`.
- `src/v2/hooks/context.ts`: registers every session hook and drives `createTransform` per pass.
- `src/v2/hooks/payload.ts`: projects the host draft into the message shape the shared transform reads, and commits the result back.
- `src/v2/store-reader.ts`, `src/v2/hooks/store.ts`: read raw history from the OpenCode 2 database.
- `src/v2/fold/owner.ts`, `fold/restore.ts`, `fold/host-media.ts`, `fold/markers.ts`: fold ownership and restoring history around host checkpoints.
- `src/v2/hidden-completion.ts`, `src/v2/hooks/hidden-child.ts`, `src/v2/hidden-child-native.ts`, `src/v2/hidden-child-cleanup.ts`: hidden model calls and cleanup of their sessions.
- `src/v2/hooks/refusal.ts`: refusing a turn before it reaches the provider.
- `src/v2/hooks/usage-reading.ts`, `hooks/usage-persist.ts`: reading and recording the provider's usage for the latest reply.
- `src/v2/hooks/channel2.ts`, `hooks/commands.ts`, `hooks/tools.ts`, `hooks/dream-trigger.ts`, `hooks/dream-manual.ts`, `hooks/update-check.ts`.
- `src/v2/tui/`: the TUI seam. `src/tui/entry.mjs` serves both TUI loaders.
- `src/shared/host-limitations.ts`: named capabilities a host lacks.
- `src/features/magic-context/store-generation-rebase.ts`, `opencode2-relabel.ts`: moving sessions between OpenCode 1 and 2 stores.

## Loading

The package's default export carries both host shapes: `{ id, server }` for OpenCode 1 and `setup` for OpenCode 2. An OpenCode 1 host can also call `setup` (its core external-plugin layer adopts any module exporting `{ id, setup }`), so `setup` first checks `isOpenCode2HostContext`: only a context whose `session.hook` is a function runs the v2 lane. Anything else logs that the v1 lane owns the host and returns a no-op disposer, which keeps an OpenCode 1 process from being tagged as harness `opencode2`. `build:v2` bundles `src/v2/server.ts` with `@opencode/plugin` as an external and runs `src/v2/server.test.ts` as part of the build.

## The context hook

`registerContext` (`hooks/context.ts`) registers the hooks once per process. On every `context` pass it:

1. Records host media classes (for restoring attachments later), lets hidden-child sessions short-circuit, and removes dreamer-only tools from primary drafts.
2. Reads the model, variant and agent from the draft itself. The draft is authoritative; nothing is reconstructed from message events.
3. Rewrites `ctx_*` tool descriptions for this draft's model (`applyV2PromptSurfaceTools`) and records the tool-definition size. Descriptions are changed on the draft only; the host keeps every `tool.transform` registration for the life of the process, so registration happens once in `tools.ts`.
4. Records the latest reply's usage (below), rebases session coordinates if the session came from the other store generation, runs the system-prompt handler on `draft.system`, and runs the shared per-message duties.
5. Restores history around a host checkpoint (see Fold ownership), projects the draft with `adaptPayload`, runs the shared transform, commits, and delivers any pending Channel 2 nudge.

The shared transform is created with `storeGeneration: "v2"` and with `v2CompactionMarkerStrategy`, whose operations are all inert: OpenCode 2 owns its checkpoint rows, so the v1 synthetic marker writes never happen here.

## Refusals and admission

A turn is refused before the provider with `session.interrupt`; the host records it as an interrupted turn with no error text, so every refusal is also logged to `magic-context.log` with its arm and cause. The arms are:

- **Usage unavailable**: the latest reply's usage could not be read or recorded (the context database is not durable, or a store read failed). A usage figure never refuses a turn by itself, however high it is: the shared transform's force band and emergency reclaim, the historian and folds all run inside the pass, and a refusal ahead of them would leave the stored reading unchanged and refuse every later turn (issue 493). Like OpenCode 1 and Pi, the turn is refused for pressure only by the shared transform after its pass, when the provider has rejected the request as too large and the pass folded nothing; that refusal posts "Context full — /ctx-flush or /clear to continue." before interrupting.
- **Blocking transform errors**: when the shared transform cannot prove a safe prompt (for example fail-closed storage), the hook interrupts and throws `V2ContextRefusal`. With compaction off, native compaction owns recovery and the pass passes the input through.
- **Post-fold restore failure** and **compaction-fold failure**: if history around a host checkpoint cannot be restored, or the fold cannot be supplied, the turn is refused rather than sent with history missing.

## Fold ownership

### Idle host checkpoints

Automatic host folding is enabled whenever Magic Context compaction is enabled. Keeping the provider prompt small does not stop OpenCode from loading every stored row since its last checkpoint before the context hook runs. Once at least 1,000 rows remain after that checkpoint, `fold/idle.ts` and `fold/policy.ts` nominate a host checkpoint only between turns and strictly after the last successful response's frozen `cacheTtl`. A new turn, interruption, failure, deletion or disposal cancels the idle deadline; `cache_ttl: "never"` does not create one. There is no separate opt-in setting.

The policy rechecks idle eligibility after asynchronous admission work, then calls `session.compact({ sessionID, id, delivery: "queue" })` with a deduplicated admission ID. The tested 2.0.22, 2.1.0 and 2.2.2 hosts drain an idle queued compaction without another user turn. This moves the host's loading boundary forward after the provider cache has already expired, rather than interrupting a turn or causing an extra cache rebuild.

`fold/native-replay.ts` preserves the host's rendered message objects, including attachment objects and provider metadata, around the checkpoint. Its process-local cache retains only raw rows after the persisted summary boundary when that summary is the history-head message (`m[0]`) actually sent to the provider; the existing 16 MiB per-session budget is unchanged. Eviction does not veto a fold: an admission without a capture restores the required rows from the host store and logs `capture=absent`. The separate V3 admission record stores store/summary/history digests, a validated source replay floor and the positions and values of host effort controls, not conversation text. Those controls preserve the reasoning-effort setting across a fold. A restart or an invalidated capture reconstructs only above that floor; when a checkpoint has no usable floor, the adapter logs a refusal instead of replaying from the first message. Imported Magic Context checkpoints supply a floor too. The V2 format remains unchanged, and the V2 reader refuses V3 records rather than interpreting them as V2. V1 admission remains revoked; its old records are only cleaned up. A valid V2 receipt upgrades on a recorded upgrade-state rebuild that can replace the frozen history head, only when its exact stored summary proves which source rows it covers. A host `keepID` alone is not a coverage proof. Without that boundary, a host checkpoint containing the complete earlier transcript can be replayed alongside the later raw messages. If neither form of coverage is available, valid V2 receipts alone may read and repair their source once on the same upgrade rebuild; the new V3 floor is persisted only after that request has been prepared successfully and passes the checkpoint size check. Interrupted repairs save no V3 floor and retry. Ordinary V3 admission never guesses an origin. A retained host transcript is retired through `FoldOwner`'s existing recent-context repair only after our summary covers the old rows and this request's context transform authorizes replacing the frozen history prefix; checkpoint size is still checked before egress. Provider-owned checkpoints remain host-owned.

### Supplying and restoring checkpoints

OpenCode 2 compacts by asking a `compaction` hook for a summary and writing a checkpoint row. Magic Context answers with the served module baseline, captured `m[0]`, or persisted `m[0]`, so the host receives Magic Context's account of the session instead of asking a model for a second summary. Native replay admits the running checkpoint by ID and persists its provenance and bounded replay coordinates. If native admission cannot be supplied, `FoldOwner` (`fold/owner.ts`) remains the fallback: it lazily materializes a baseline and records the highest source sequence covered and the submitted summary rather than leaving the host hook unanswered. That sequence is provisional because the host has not yet assigned the checkpoint row's final sequence.

On later passes, when the store reader finds a checkpoint in the draft, the adapter:

- distinguishes local checkpoints from provider-owned windows, and validates native admission against the store, summary and pre-cut history;
- restores native carriers from the bounded cache or source rows between the end of the history already represented by `m[0]` and the checkpoint cut. An unadmitted local checkpoint uses ordinary source reconstruction (`fold/restore.ts`). Only an existing `FoldOwner` record bound to the same cut and summary can preserve a legacy carrier and its metadata; unknown native wrappers are not adopted as legacy state. A boundary on a row the host never serves by id (an instruction update) is moved back to the nearest served row;
- runs the shared transform over that history. Admitted native folds serve Magic Context's first two generated context messages—the frozen history summary (`m[0]`) and incremental new summaries (`m[1]`)—followed by the unsummarized raw tail, instead of the host's raw checkpoint wrapper. Matching legacy carriers keep their frozen identity until the shared transform permits replacing that prefix, for example on first render, cache expiry, or a model, system or history change. These prefix-replacement decisions are called `HARD`: they rebuild the cached history messages and open the queued-mutation gate. Ordinary defer passes reuse unchanged bytes. A repair that retires an old serialized recent-context block must use that same decision, not mutate a frozen record during defer. Source edits invalidate cached history and go through this shared decision rather than rewriting a served prefix in place.

Attachments on restored rows must be instances of the host's own `Media.Asset` class on OpenCode 2.0.15 and later. `fold/host-media.ts` obtains the constructor from an asset the host already put in a draft, or from the host's schema; when neither works, the attachment is replaced by a short deterministic note so the replay stays byte-stable.

## Hidden completions

OpenCode 2 gives plugins no child-session prompt loop, so hidden model work runs through `hidden-completion.ts`, a `generate`-backed executor. `hooks/hidden-child.ts` registers three hidden agents with no tools (`historian`, `dreamer-classifier`, and the base `dreamer` agent), shapes prompts that match a known marker into text-only drafts, applies output caps and temperature only when configured, and refuses unrecognised prompts on sessions it owns. Empty or length-capped completions are rejected before parsing.

What runs through it:

- **The historian**, whenever compaction is on, the executor exists and the historian is not disabled (`historianRunnable`).
- **`/ctx-wrapup`** and manual `/ctx-dream` (`hooks/dream-manual.ts`).
- **Scheduled dreamer tasks**, woken by execution events (`hooks/dream-trigger.ts`). `tool-loop` tasks run through fresh task-scoped hidden children; the host executes their permitted tools and the existing manifest parsers apply the result (see [dreamer.md](dreamer.md)).

OpenCode 2.0.22 or newer is required: startup checks for `session.remove` and `session.compact`, not a version string. Unsupported hosts refuse turns before the provider and show one upgrade notice. Each hidden run gets a fresh child with `parentID`; its location is inherited rather than sent. The host removes it on completion, with idempotent not-found handling and a bounded shutdown wait. `keep_subagents: true` keeps settled children and historian children. On upgrade, legacy `opencode2_hidden_children:*` records are drained through `session.remove` in bounded, resumable boot batches; a completion record stops further sweeps.

## Commands, tools and Channel 2

- `hooks/tools.ts` registers the shared `ctx_*` tools once.
- `hooks/commands.ts` registers `/ctx-status`, `/ctx-recomp`, `/ctx-dream`, `/ctx-flush`, `/ctx-embed` and `/ctx-wrapup` through the host's command domain when it exists; a host without one leaves them TUI-only.
- Channel 2 (see [nudges.md](nudges.md)) is sent with `session.synthetic({ delivery: "steer" })`. Each id is recorded in plugin storage so later passes recognise it as an admitted synthetic message rather than a real user turn.

## TUI seam

`src/v2/tui/index.ts` exports `setup(context)` over the `V2TuiContext` contract (`tui/types.ts`, pinned by `tui/host-contract.test.ts`). It mounts the OpenCode 1 sidebar component into the `sidebar.content` slot through the host's OpenTUI runtime, and mounts the OpenCode 1 status dialog the same way; if the host cannot load them, both fall back to a plain-text projection. OpenCode 2 has no `command.execute.before` hook, so every `/ctx-*` command in the TUI is a keymap-layer command whose `run` calls the matching RPC handler and reports through a dialog or toast. Data comes from the shared RPC-backed layer in `src/tui/data/`. `src/tui/entry.mjs` is the `./tui` export for both hosts: its default object carries the v1 `tui` and a `setup` that loads the v2 seam.

## Host limitations

A host limitation is a capability the current host lacks for the life of the process. `declareHostLimitation` (`shared/host-limitations.ts`) records it once; status surfaces keep printing it with its `MC-*` code. The OpenCode 2 adapter uses native session cleanup and supports Rust transform mode, so neither requires a host limitation.

## Moving between OpenCode 1 and 2 stores

A session can be read from OpenCode 1 tables and later from OpenCode 2's `session_message`, which numbers the same conversation differently. `store-generation-rebase.ts` (`rebaseSessionCoordinates`) records which store generation a session's coordinates belong to (`session_meta.coordinate_generation`) and, on a switch, re-maps stored message ordinals. Compartments whose range cannot be re-mapped are marked in `rebase_status` and excluded from range recovery and history refresh until resolved. The v2 hook rebases before the system-prompt handler so a converted session initialises the new host's prompt hash instead of arming a redundant fold. `doctor` reports these rebases (`doctor-store-generation.ts`).

Session rows carry a `harness` label, `opencode` or `opencode2`. `opencode2-relabel.ts` repairs labels from store evidence, choosing whichever store's activity for the session is newer; `doctor-harness-relabel.ts` exposes the same check.
