# mc-app-read-samples-v17

Examples for the internal `mc-app-read/v1` service, which the CortexKit apps call
to show a session's context. v17 is v16 with three examples added; every v16 file
is copied byte for byte. The callers, the version and the `{"result": ...}`
envelope are as [the v15 notes](../mc-app-read-samples-v15/README.md) describe.

## What changed from v16

- **New read, `dreamer.docs_proposal {project}`.** The project's pending
  docs-upkeep proposal, for the dreamer page: the dreamer's `maintain-docs`
  task reads the code changed since its last run and proposes changes to the
  project's `ARCHITECTURE.md` and `STRUCTURE.md`. The reply is
  `{"proposal": null}` when the project has none, and otherwise:
  - `id`, `created_at_ms` and `status` (always `pending` here: a proposal is
    checked against the documents on every read, and one that was applied or
    went stale is not shown again);
  - `documents`: each document the proposal changes, with `name`, `diff` (the
    unified diff from the document as read to the document with the changes)
    and `changes` (`action`, `heading`, `reason` of each kept change);
  - `dropped`: each change the task's checks refused, with `file`, `action`,
    `heading` and the `reason` it was refused.

  A project the reads don't know is refused `project_unknown`, as for the
  other project reads. A proposal made, dismissed or changing status sends the
  project's existing `dreamer` watch notice.
- **Added samples.** `docs-proposal.json` (one change kept, one dropped),
  `docs-proposal-none.json` (a known project with no proposal) and
  `docs-proposal-unknown.json` (the refusal). They come from a fixture store
  and checkout through the module's own read; regenerate them with
  `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib
  app_read::samples_v17_tests::samples_v17 -- --exact`.

The person dismisses a proposal with the user command `docs_proposal_dismiss`
(see `mc-user-commands-samples-v3`). For every other example, see
[the v16 notes](../mc-app-read-samples-v16/README.md) and the earlier sets they
link to; those examples are unchanged.
