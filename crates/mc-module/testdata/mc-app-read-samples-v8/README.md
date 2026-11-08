# mc-app-read-samples-v8

The six `mc-app-read/v1` app operations and watch StreamData, generated from
ck-mc's app-read handlers. Existing sample folders remain frozen. No response
fields, routes, role versions or store schemas change.

Token breakdown category labels now reflect the provenance of their tokens:
`estimate` is false when all contributing tokens are `runner` or `counted`.
Categories containing `reported` or `estimate` contributions remain estimates.
Missing surface counts remain null and estimated; runner surface counts retain
the runner's explicit exactness flag. Empty categories have no estimated tokens.

The header's `estimation_source` is the source contributing the most tokens,
using the existing `runner`, `counted`, `reported` and `estimate` vocabulary.
Ties favor the less exact source in that order. The provider-reported prompt
total remains independent: unattributed tokens do not invent a source.
Provenance is updated alongside cached message counts, including removals and
late runner measurements, without walking the entire transcript per notice.

Compared with v7, `token-breakdown.json` changes category `estimate` values and
the dominant-source label; its content-derived version changes with them.
All other operation samples remain byte-identical.

Regenerate from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v8 -- --exact
```
