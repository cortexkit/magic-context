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

`describe.json` also declares `wrapup` with the optional `messages_to_keep`
number (a nonnegative safe integer, default 20). `wrapup-preview-available.json`
counts four older messages and about 400 tokens to summarize, leaving 20 raw.
`wrapup-preview-unavailable.json` covers `within_keep`, where the requested
keep count covers all raw messages. `wrapup-run.json` records a scheduled
anchored target, not completed summaries. The contract has no `tells_agent`
field: wrapup tells the agent nothing and sends no session reminder. Large targets
can take several model runs. Status shows their target and summarized ordinal.
Summaries land on the next rebuild, or at once at the rebuild threshold;
`flush` applies published summaries now. `ctx_expand` recovers the raw text.

`queued_in_recent_tail` means every queued part is still in the protected recent
tail and the rebuild has no other work to land. An explicit flush keeps that
protection. Status counts only parts outside the tail in `Queued drops` and
`Queued tokens`; its expanded table counts protected queued parts separately as
`Held in recent tail`.
