# Dreamer verify replay

Replays ck-mc's `verify` and `verify-broad` dreamer tasks on a real project, so
every request and every step of a model's work can be read before the tasks are
switched on. Nothing here writes to a live store.

## 1. Write the requests

The ignored Rust test plans each task on a copy of a store and the project's git
checkout, exactly as a run plans it, and writes one request per batch:

```sh
DREAMER_REPLAY_STORE=/path/to/context-copy.db \
DREAMER_REPLAY_CHECKOUT=/path/to/project \
DREAMER_REPLAY_PROJECT=<project id in the store> \
DREAMER_REPLAY_OUT=/path/to/new-output-folder \
  cargo test --locked -p mc-module --lib dreamer::verify_replay_tests::verify_requests -- --ignored --nocapture
```

Optional: `DREAMER_REPLAY_KINDS=verify` or `verify-broad` (both by default),
`DREAMER_REPLAY_BATCHES=<n>` to write only the first batches of each, and
`DREAMER_REPLAY_MODEL` for the model a request names (`deepseek-flash` by default).

The output folder gets `store.db` (the copy the run was planned on),
`manifest.json`, and `<kind>/batch-<n>/verify.request.json`: the system and user
text, the module's settings (reply limit, step bound), the memories the batch
read, whether it carries a diff, and what the plain search of the checkout did.

## 2. Run one request

`verify-run.ts` sends one request to DeepSeek's chat-completions API and plays
the runner's part: it offers `read` (with a line range), `grep` and `glob`,
confined to the checkout (no path outside it, no symlink out of it), and runs
the tool loop until the model answers or the request's step bound is reached.
It writes `verify.trajectory.json` beside the request, with every request body,
every reply as returned (reasoning included) and every tool call with its full
input and output. It never overwrites a trajectory and writes nothing else.

The key comes from the vault, through the e2e harness's credential client, and
reaches the runner only on standard input:

```sh
bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
  --request /path/to/new-output-folder/verify/batch-0/verify.request.json \
  --checkout /path/to/project
```

`verify-run.ts` also takes `--model`, `--endpoint` and `--temperature` (0.1 by
default). The trajectory's `final.completeManifest` says whether the final
message held one complete `<verify>` manifest, which the module requires.
