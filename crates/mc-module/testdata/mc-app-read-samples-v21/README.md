# mc-app-read-samples-v21

The role version and the request and reply shapes are unchanged. Every v20
JSON sample is copied byte for byte except `search.json`.

In `context.search`, `next_cursor` is still an opaque string. The next page
continues from the last hit's ranking position, not from a count of hits.
Inserting a new matching message ahead of that position no longer repeats or
skips a hit by shifting the page boundary. If the search corpus changes enough
to change the ranking scores, a hit can still move across that boundary.

A cursor issued by an earlier build is refused with `cursor_invalid`. The
reader starts again at page one without a cursor.

Regenerate from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v10 -- --exact
```

Use an output directory instead of `1` for a read-only checkout. The test
regenerates v21 only, leaving v10 frozen. Without the variable, it checks
every v21 sample and the sorted JSON-only `SHA256SUMS`. See the
[v20 notes](../mc-app-read-samples-v20/README.md) for the previous examples
and their wire contracts.
