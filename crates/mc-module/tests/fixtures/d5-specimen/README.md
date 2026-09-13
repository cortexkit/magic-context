# D5 specimen fixture

This is the MC-owned, **DERIVED** and sanitized specimen for the D5 uncovered predecessor tail. It carries 141 ordered members (1799–1939) for joint Magic Context/Thalamus replay without committing the private source capture or store.

Provenance:

- store membership and tagged-member kinds: `VACUUM f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0`
- byte lengths, untagged-member kinds, roles, block geometry, and tool links: capture `13610-req-body`, SHA-256 `766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b`
- attribute counts: lengths: 141 from capture; kinds: 83 from db, 58 from capture; tool links: 141 from capture

Sanitization preserves message order, ordinals, roles, normalized source block counts and kinds, each provider block's JSON structure, per-block encoded byte lengths, every string leaf's decoded UTF-8 byte length, reduction lengths, and closed tool-use/result arcs. All 188 blocks preserve both length measures; zero are encoded-only or decoded-only, and this capture contains zero opaque blocks. Object keys, nesting, arrays, numbers, booleans, and nulls are real; string leaf values are synthetic equal-length fillers chosen from the source character's JSON escape and UTF-8 width class. The recognized compaction instruction at 1939#1 is excluded as a contract provenance addition rather than treated as predecessor source. Only the approved probe string in each of ordinals 1824, 1864, and 1927 remains verbatim at its original position inside its synthetic string value. It does **not** preserve token counts, historian quality, semantic content outside those probes, or provider-valid reasoning signatures. Reasoning signatures are synthetic.

Contract clause 2 (types) pins `NativeBlock.bytes` to this normative canonical JSON algorithm:

1. Parse valid JSON while retaining whether every number used integer syntax or fraction/exponent syntax, and emit UTF-8.
2. Sort object keys lexicographically by Unicode code point, never by key length or source order.
3. Use `,` and `:` separators with no surrounding whitespace.
4. Do not ASCII-escape non-ASCII characters. Escape only quote, backslash, and U+0000–U+001F: use `\n`, `\r`, `\t`, `\b`, and `\f` short forms, and lowercase `\uXXXX` for the remaining controls.
5. N1 — Preserve an integer-syntax number as canonical decimal text: no leading `+` or zeroes, map `-0` to `0`, and never route arbitrary-magnitude integers through binary64.
6. N2 — Parse a fraction- or exponent-syntax number as finite IEEE-754 binary64 and serialize it with ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20 / `JSON.stringify`): shortest round-trip digits; plain decimal when 1e-6 ≤ |x| < 1e21, otherwise lowercase exponent notation with `+` retained for positive exponents; omit an integral fraction and map negative zero to `0`.
7. N3 — Apply N1/N2 independently of language-default number formatters; Python re-lays out `repr`'s shortest digits instead of emitting `repr` directly, and Rust uses an exact ECMAScript formatter rather than `serde_json` Display.
8. N4 — At every block boundary, classify by decoded context, wire role, and payload validity, never by a raw `type` allowlist. `TopLevel` follows Broca `decode_content_block` (`79b1272e` `anthropic_decode.rs:560-607`); `ToolResultChild` follows `decode_result_block` (`79b1272e` `anthropic_decode.rs:648-661`). Canonicalize only blocks those functions decode to typed `ContentKind` or `ResultBlockKind`; preserve every other block's exact raw bytes. Descend only from a known user-role `tool_result` container into its content array. `tool_use` input is ordinary JSON data and is never block-scanned. If any opaque descendant lacks its raw bytes, refuse canonicalization rather than reconstructing it.
9. Emit no trailing newline.

Decoded-boundary table:

| Context | Role | Block/payload | Boundary result | Pinned decoder |
|---|---|---|---|---|
| `TopLevel` | any | `text` with string `text` | known `text` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `thinking` with string `thinking` and `signature` | known `reasoning`; both fields retained | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `thinking` without a valid string signature | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `redacted_thinking` with string `data` | known `redacted_reasoning` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | assistant | `tool_use` with string `id`/`name` and present `input` | known `tool_use` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | user | `tool_use` | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | user | `tool_result` with string `tool_use_id` and present `content` | known container; children use `ToolResultChild` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `image` or `document` | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | malformed payload of a recognized type | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | unknown type | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `ToolResultChild` | user | `text` with string `text` | known `ResultBlockKind::Text` | `79b1272e anthropic_decode.rs:648-661` |
| `ToolResultChild` | user | anything else, including signed `thinking` or nested `tool_result` | opaque child, exact raw bytes, no recursion | `79b1272e anthropic_decode.rs:648-661` |

These rules are the definition; `canonical-json-vectors-v1.json` contains independent hand-written conformance checks designed to distinguish wrong ordering, escaping, and number algorithms. Decoder-known top-level blocks lift `type`, `id`, and `tool_use_id` into contract kind/tool-link fields while retaining every other provider field. Scalar text is normalized as `{"text": ...}`. Archive `V` entries are base64 compact JSON renderings of `NormalizedMessage` in contract field order; the applied-state payload is a stable JSON scaffold for units, tags, drops, and ledger without token counts or clocks.

## Opaque blocks

A decoder-opaque provider block lifts nothing, receives kind `opaque`, and preserves its exact raw provider bytes, including key order, whitespace, and escape and number spelling. This includes top-level image/document blocks, malformed recognized types, role-invalid typed blocks, unknown types, and every non-text `ToolResultChild`. Raw preservation keeps content and identity digests over opaque blocks equal across adapters; in this derived fixture only string values are sanitized in place, without re-serializing or changing any non-string byte.

N4's decoded-context boundary is the pinned Claude Code D5 rule, not a fixture convenience. The parent `tool_result` object and known text children remain canonical around each raw opaque child. A nested `tool_result` is itself opaque and is not recursively treated as a container. Canonicalization refuses when an opaque descendant's raw bytes are unavailable. Widening requires a contract and vector revision.

OpenCode and Pi consume different API structures and are not inputs to the Claude Code D5 rule. OpenCode emits decoded `Text` from `output_text` at `opencode.rs:703-707` and separately classifies attachments at `opencode.rs:719-738`; Pi parses its separate harness surface at `pi.rs:845-892`. Their current classification differences belong to a parity follow-up, not this fixture's identity rule.

`expected-manifest-v1.json` and `expected-archive-v1.json` remain scaffolds, not oracles, despite the real structure and lengths. Readiness stays `scaffold` until slice 0 fills every pending digest from **independent** reference-implementation preimage vectors and hand-checked CE1 preimage vectors—not from the codec under test—and freezes the results.

## Redeem vector encoding

No D5 lineage serializer exists at this baseline. The closest tagged module fixture union is internally tagged (`crates/mc-module/src/tail_hygiene.rs:1212-1238`), while the current facade state-sync request is a struct rather than an operation union (`crates/mc-module/src/lib.rs:793-863`). Clause 2 therefore controls deliberately: `LineageRequest` is one internally tagged object whose `op` discriminator and redeem fields are siblings with no `args` wrapper; `LineageResponse` uses the externally keyed clause spelling `{"redeem":{"result":...}}`; and nested payload unions are internally tagged by `kind`. This is the pinned wire rule slice 2 must implement. The owner-authored expectations in `redeem-vectors-v1.json` are independent fixture data, never generated from the precedence evaluator.

Regenerate from the two private inputs:

```sh
python3 packages/plugin/scripts/gen-d5-specimen-fixture.py \
  /path/to/d5-specimen.db \
  /path/to/13610-req-body
```

The generator refuses either input unless its SHA-256 matches the values above. `fixture-index-v1.json` catalogs every sibling fixture file; it cannot hash itself without a recursive self-reference.
