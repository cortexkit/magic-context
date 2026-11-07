What broca serves for Thalamus's `opencode2` export after importing it into a session in the new storage, written by `dump_head_import_entries` in `crates/broca-module/src/store_actor/entries_comparison.rs`.

- `import-reply.json`: the `session.import` reply, move list included.
- `entries-1.refused.json`: the `compaction-runner/v1` route's refusal of `session.entries` to `magic-context`, exactly as returned: compaction_not_permitted (no_compaction_item). This is expected: a moved head gets its plan, naming its compaction provider, from core's adopt after the import, and until then the route has no compaction provider to admit.
- `entries-unadmitted-<n>.json`: not route bytes: the page the route serves once the session's plan names the compaction provider, built by the route's own page function (`store_entries::entries_page`), from the first entry on in full detail, following `next_after`.
- `comparison.md`, when the export folder holds Thalamus's own `entries-<n>.json`: one row per source message id with each side's entry ordinal and part ids, then any entry broca adds.
- `SHA256SUMS`: every file above.
