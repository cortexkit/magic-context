# Broca media reader fixtures

The JSONL files and `SHA256SUMS` in this directory are unchanged copies of the
first synthetic shipping-build captures supplied by Broca. The second set,
including the production `media: "descriptors"` reads and default reads, is in
`../broca-media-set2/`. Both manifests were verified before copying. The Rust
fixture test checks every manifest entry again (16 files here, 22 in set 2).
The supplied `README.md` in each directory describes how the captures were made;
these are real reader/renderer paths over synthetic content, not live provider
requests or a live session store.

## Identity boundary

The owned-broca ingress API already contains `serde_json::Value`. Tests require
exact Value equality and identical serialization of those Values, including all
string bytes and integer values. They do not assert original JSONL member order:
that order is lost before codec ingress, and Broca decodes view edits into typed
protocol values. No workspace-wide JSON map-order feature was enabled.

## Text and tags

`on-session-read.jsonl` m2 contains person media and m4 contains text/image/PDF/text
parts. The codec's text projection joins the original text and the carrier-off
marker lines with newlines. The family matrix tests also compare actual rendered
request text: supported media are not text; unsupported media remain exact marker
lines. In particular, Chat renders tool media as markers and has no synthetic
"Media from tool call" user message. Historian expansion templates retain their
existing line-break normalization.

The first off-mode m4 contains only text parts. One literal text part includes an
old unsupported-content fallback containing base64. It is intentionally preserved:
the codec does not sanitize text that Broca already stored and showed the model.
MediaRef rendering itself never exposes payloads, base64, or a full digest.

The supplied reads have unnumbered tag rows. Tests pin their real outer part keys,
including the unnumbered person-media `m2#1` row and the single tool-result `m4#0`
row. A separate numbered derivative exercises `ctx_reduce` without claiming that
its numbers were present in the capture. A media-only result receives one text
label for its outer result number, never a number on a media part.

Set 2 descriptors carry top-level `media_ref` blocks with a `part` key. Nested
media descriptors also have `type: "media_ref"`, but no separate part key. Message
and part digests are checked against the corresponding inline capture, not hashes
of the descriptors. Kept descriptors round-trip unchanged; text edits to a tool
result convert its nested read descriptors back to native reference fields before
publishing an edit.
