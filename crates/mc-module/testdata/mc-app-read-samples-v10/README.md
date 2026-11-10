# mc-app-read-samples-v10

The six `mc-app-read/v1` app operations and watch StreamData, generated from
ck-mc's app-read handlers. Routes, role versions, refusals and envelopes are
unchanged. The v5 through v9 sample folders remain frozen and checksum-pinned.

## Pending runner notes

The token breakdown adds the `notes` category and a matching `notes` item.
These are runner-rendered plan and tool notes outside transcript entries, not
the user-role `notices` category. Counts come from compaction 0.3.5's optional
`Conditions.notes_tokens`, enabled by `compaction-notes-tokens/v1`.

The category reports the **measured request's** notes: the previous notice's
pending count, not the newest notice's next-request count. The sample has 11
measured note tokens and 29 pending. `notes` therefore reports 11, with
`estimate: false`. Inexact counts have `estimate: true`; an absent measured
count is unknown (`tokens: null`), not zero. Runners sending separate note
counts exclude them from `system_tokens`. Provider totals are unchanged;
attribution moves known notes out of the residual shown as Other by apps.
When neither the pending nor measured note count is known, the category and
item are omitted, preserving the breakdown from runners without this metadata.

The new category is appended to preserve existing category indices. Its item
follows `tool_definitions`, before the composed head items. Content-derived
versions and cursors change with the breakdown.

Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v10 -- --exact
```

On a read-only checkout, set `MC_REGENERATE_APP_READ_SAMPLES` to an output
directory instead of `1`, then copy the generated JSON and checksums into this
folder. Run without the variable to verify the checked-in samples.
