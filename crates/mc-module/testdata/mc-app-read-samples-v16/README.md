# mc-app-read-samples-v16

Examples for the internal `mc-app-read/v1` service. Who may call it, the
`mc-app-read/v1` version and the `{"result": ...}` envelope have not changed. v16 is
v15 with one example added; every v15 file is copied byte for byte.

## What changed from v15

- **Added sample.** `token-breakdown-long.json`: a `session_data.read`
  `token_breakdown` read from a real long head session, so the apps can test
  and draw realistic proportions. Every earlier breakdown example is a tiny
  session of 80 tokens. This one is about 598k tokens of an 872k usable
  window:
  - 13 parts, two of them estimates (`tool_definitions`, `tool_calls_results`);
  - 228 items, 222 of them summaries at several tiers;
  - a real `as_of` (a message id and its time);
  - `total.source: "provider"`.

  The items carry no free text, so nothing needed redacting. The request
  names a placeholder session (`s-long`), and the envelope's `as_of_ms` is
  the fixed value every example uses.

The v15 notes on the head outline, the owner reads and the watch notices
still apply unchanged.
