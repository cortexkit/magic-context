# ck-mc user-command samples

These wire bodies come from the real ck-mc command handlers using synthetic
sessions, not live stores. Regenerate them with:

```sh
MC_UPDATE_USER_COMMAND_SAMPLES=1 cargo test -p mc-module --lib --locked user_commands_record_real_handler_samples
```

When the checkout is read-only, also set `MC_USER_COMMAND_SAMPLES_DIR` to a
writable output folder, then copy the generated JSON files and `SHA256SUMS`
back here. Without that override the generator writes to this fixture folder.

`SHA256SUMS` covers the generated JSON files. `describe.json`,
`status-preview.json` and `flush-run.json` record the command declarations,
expanded status and a scheduled flush. The flush preview samples cover an
available rebuild and the unavailable reasons `not_managed`, `nothing_to_land`,
`queued_in_recent_tail`, `summary_running` and `thinking_hold`.

`queued_in_recent_tail` means every queued part is still in the protected recent
tail and the rebuild has no other work to land. An explicit flush keeps that
protection. Status counts only parts outside the tail in `Queued drops` and
`Queued tokens`; its expanded table counts protected queued parts separately as
`Held in recent tail`.
