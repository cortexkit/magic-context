# Dreamer replay

Replays ck-mc's `verify`, `verify-broad`, `map-memories`, `refresh-primers`,
`reflect-events` and `maintain-docs` dreamer tasks on a real project, so every request and every
step of a model's work can be read before the tasks are switched on. Nothing
here writes to a live store.

## 1. Write the requests

An ignored Rust test plans each task on a copy of a store and the project's git
checkout, exactly as a run plans it, and writes one request per batch. The
verify, map and primer tests read the same variables:

```sh
DREAMER_REPLAY_STORE=/path/to/context-copy.db \
DREAMER_REPLAY_CHECKOUT=/path/to/project \
DREAMER_REPLAY_PROJECT=<project id in the store> \
DREAMER_REPLAY_OUT=/path/to/new-output-folder \
  cargo test --locked -p mc-module --lib dreamer::verify_replay_tests::verify_requests -- --ignored --nocapture
```

For the map task, run `dreamer::map_replay_tests::map_requests` instead, and
for the primers `dreamer::primer_replay_tests::primer_requests`, with the same
variables and a new output folder.

Optional: `DREAMER_REPLAY_BATCHES=<n>` to write only the first batches of each
task, and `DREAMER_REPLAY_MODEL` for the model a request names
(`deepseek-flash` by default). The verify test also takes
`DREAMER_REPLAY_KINDS=verify` or `verify-broad` (both by default). The primer
test takes `PRIMER_REPLAY_LIMIT=<n>` to write more primers than one run
refreshes (5).

The output folder gets `store.db` (the copy the run was planned on),
`manifest.json`, and one request per batch:

- `<kind>/batch-<n>/verify.request.json` for `verify` and `verify-broad`: the
  system and user text, the module's settings (reply limit, step bound), the
  memories the batch read, whether it carries a diff, and what the plain search
  of the checkout did.
- `map-memories/batch-<n>/map.request.json` for the map task: the system and
  user text, the same settings, and the memories the batch read, each with the
  likely files its message lists and where they came from (the paths its text
  names, or the module's search of the checkout for the code names it
  mentions).
- `refresh-primers/primer-<n>/refresh.request.json` for the primers: the system
  and user text, the same settings, and the primer. The test first runs the
  task's promotion on the copy (by question text, as a run without an embedding
  provider does), so the copy holds the primers the run would refresh.

The map and primer tests refuse a store, checkout or output folder inside the
live data folder (`~/.local/share/cortexkit/`), open the store read-only, copy
it with `VACUUM INTO`, and bring the copy to the module's schema before
planning.

### Reflect

The reflect task reads no code, so its test takes no checkout:

```sh
REFLECT_REPLAY_STORE=/path/to/context-copy.db \
REFLECT_REPLAY_PROJECT=<project id in session_projects> \
DREAMER_REPLAY_OUT=/path/to/new-output-folder \
  cargo test --locked -p mc-module --lib dreamer::reflect_replay_tests::reflect_requests -- --ignored --nocapture
```

It writes `reflect/batch-<n>/reflect.request.json` per message: the system and
user text, the settings, the groups the message shows and the existing
memories. Optional: `REFLECT_REPLAY_SINCE_EVENT=<event id>` treats the events
up to that id as read by an earlier run; without it every event is new unless
the copy holds a watermark.

Once a reply is beside a request, the apply step applies it to a throwaway copy
of the replay's `store.db` with the task's own checks, and prints and writes
(`reflect.apply.json`) every learning written and every one dropped, with why:

```sh
DREAMER_REPLAY_OUT=/path/to/the-output-folder \
REFLECT_REPLAY_BATCH=0 \
  cargo test --locked -p mc-module --lib dreamer::reflect_replay_tests::reflect_apply -- --ignored --nocapture
```

It reads the batch's `reflect.reply.json` (from `send.ts`) or
`reflect.trajectory.json` (from `verify-run.ts`), or the file
`REFLECT_REPLAY_REPLY` names.

### Docs upkeep

The docs task reads the change since the commit it last processed. Its test
takes that commit instead of the task's stored one:

```sh
DOCS_REPLAY_STORE=/path/to/context-copy.db \
DOCS_REPLAY_CHECKOUT=/path/to/project \
DOCS_REPLAY_PROJECT=<project id in the store> \
DOCS_REPLAY_FROM_COMMIT=<commit to read the change from> \
DREAMER_REPLAY_OUT=/path/to/new-output-folder \
  cargo test --locked -p mc-module --lib dreamer::docs_replay_tests::docs_requests -- --ignored --nocapture
```

It writes `maintain-docs/run-0/docs.request.json`: the system and user text,
the settings, and the commits the change runs between. When the task's gate
sends nothing (no change outside the documents, nothing the documents name, a
document with uncommitted edits), the manifest's `skipped` says why and no
request is written. The test refuses a store, checkout or output folder inside
the live data folder, and copies the store as the others do; the project's
pending proposals in the copy are set aside so planning never judges them
against the checkout.

The apply step applies a reply to a throwaway copy of the replay's store with
the task's own checks, and prints and writes (`docs.apply.json`) each kept
change, each dropped one with its reason, and each document's diff. It writes
nothing into the checkout:

```sh
DREAMER_REPLAY_OUT=/path/to/the-output-folder \
  cargo test --locked -p mc-module --lib dreamer::docs_replay_tests::docs_apply -- --ignored --nocapture
```

It reads the run's `docs.reply.json` or `docs.trajectory.json`, or the file
`DOCS_REPLAY_REPLY` names.

## 2. Run one request

`verify-run.ts` sends one request of any of these kinds to DeepSeek's
chat-completions API and plays the runner's part. For a kind that reads code it
offers `read` (with a line range), `grep` and `glob`, confined to the checkout
(no path outside it, no symlink out of it), and runs the tool loop until the
model answers or the request's step bound is reached; a reflect request gets no
tools and needs no checkout. It writes the trajectory beside the request, as
`verify.trajectory.json`, `map.trajectory.json`, `refresh.trajectory.json`,
`reflect.trajectory.json` or `docs.trajectory.json`, with every request body, every reply as returned
(reasoning included) and every tool call with its full input and output. It
never overwrites a trajectory and writes nothing else. A request of any other
kind is refused.

The key comes from the vault, through the e2e harness's credential client, and
reaches the runner only on standard input:

```sh
bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/verify/batch-0/verify.request.json \
  --checkout /path/to/project

bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/map-memories/batch-0/map.request.json \
  --checkout /path/to/project

bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/refresh-primers/primer-0/refresh.request.json \
  --checkout /path/to/project

bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/reflect/batch-0/reflect.request.json

bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/maintain-docs/run-0/docs.request.json \
  --checkout /path/to/project
```

`verify-run.ts` also takes `--model`, `--endpoint` and `--temperature` (0.1 by
default). The trajectory's `final.completeManifest` says whether the final
message held the one answer the module requires of the request's kind:
`<verify>…</verify>` for verify, `<mappings>…</mappings>` for map,
`{"answer": "…"}` for a primer, `<learnings>…</learnings>` for reflect, and a
JSON array (`[]` included) for docs upkeep.
