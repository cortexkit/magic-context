# Dreamer replay

Replays ck-mc's `verify`, `verify-broad` and `map-memories` dreamer tasks on a
real project, so every request and every step of a model's work can be read
before the tasks are switched on. Nothing here writes to a live store.

## 1. Write the requests

An ignored Rust test plans each task on a copy of a store and the project's git
checkout, exactly as a run plans it, and writes one request per batch. Both
tests read the same variables:

```sh
DREAMER_REPLAY_STORE=/path/to/context-copy.db \
DREAMER_REPLAY_CHECKOUT=/path/to/project \
DREAMER_REPLAY_PROJECT=<project id in the store> \
DREAMER_REPLAY_OUT=/path/to/new-output-folder \
  cargo test --locked -p mc-module --lib dreamer::verify_replay_tests::verify_requests -- --ignored --nocapture
```

For the map task, run `dreamer::map_replay_tests::map_requests` instead, with
the same variables and a new output folder.

Optional: `DREAMER_REPLAY_BATCHES=<n>` to write only the first batches of each
task, and `DREAMER_REPLAY_MODEL` for the model a request names
(`deepseek-flash` by default). The verify test also takes
`DREAMER_REPLAY_KINDS=verify` or `verify-broad` (both by default).

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

The map test refuses a store, checkout or output folder inside the live data
folder (`~/.local/share/cortexkit/`), opens the store read-only, copies it with
`VACUUM INTO`, and brings the copy to the module's schema before planning.

## 2. Run one request

`verify-run.ts` sends one request of either kind to DeepSeek's chat-completions
API and plays the runner's part: it offers `read` (with a line range), `grep`
and `glob`, confined to the checkout (no path outside it, no symlink out of
it), and runs the tool loop until the model answers or the request's step bound
is reached. It writes the trajectory beside the request, as
`verify.trajectory.json` for a verify request and `map.trajectory.json` for a
map request, with every request body, every reply as returned (reasoning
included) and every tool call with its full input and output. It never
overwrites a trajectory and writes nothing else. A request of any other kind is
refused.

The key comes from the vault, through the e2e harness's credential client, and
reaches the runner only on standard input:

```sh
bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/verify/batch-0/verify.request.json \
  --checkout /path/to/project

bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/map-memories/batch-0/map.request.json \
  --checkout /path/to/project
```

`verify-run.ts` also takes `--model`, `--endpoint` and `--temperature` (0.1 by
default). The trajectory's `final.completeManifest` says whether the final
message held one complete manifest of the request's kind, which the module
requires: `<verify>…</verify>` for verify, `<mappings>…</mappings>` for map.
