# Canonical language names and TypeScript follow-up

The integration owner selected the existing macOS TypeScript output (Bun 1.4.2,
ICU 78.1) as the canonical static table. Do not select names by Rust target OS.
Live Linux TypeScript (Bun 1.4.2, ICU 78.3) differs in the following **17 names**;
these changes are observed output, not changes made to TypeScript in this work.
Both runtimes resolve the same 190 two-letter codes, including legacy aliases.

| Code | Canonical macOS ICU 78.1 | Live Linux ICU 78.3 |
|---|---|---|
| co | Corsican (corsu) | Corsican |
| cr | Cree (ᓀᐦᐃᖬᐍᐏᐣ) | Cree |
| dv | Dhivehi (ދިވެހިބަސް) | Divehi |
| dz | Dzongkha (རྫོང་ཁ་) | Dzongkha (རྫོང་ཁ) |
| gn | Guarani (avañe’ẽ) | Guarani |
| ht | Haitian Creole (Kreyòl Ayisyen) | Haitian Creole |
| hu | Hungarian (Magyar) | Hungarian (magyar) |
| ii | Liangshan Yi (ꆈꌠꉙ) | Sichuan Yi (ꆈꌠꉙ) |
| iu | Inuktitut (ᐃᓄᒃᑎᑐᑦ) | Inuktitut |
| ms | Malay (Bahasa Melayu) | Malay (Melayu) |
| nv | Navajo (Diné Bizaad) | Navajo |
| se | North Sámi (davvisámegiella) | Northern Sami (davvisámegiella) |
| sm | Samoan (Gagana faʻa Sāmoa) | Samoan |
| ss | Swati (siSwati) | Swati |
| ts | Tsonga (Xitsonga) | Tsonga |
| ve | Venda (Tshivenḓa) | Venda |
| wa | Walloon (walon) | Walloon |

## Follow-up spec: one shipped static table for both implementations

1. Treat `crates/mc-module/assets/tool_catalog_v1.json`'s `language_names` member
   as the current canonical data, validated against the committed macOS golden.
   Extract it into one standalone shared JSON asset during the follow-up if
   packaging needs a smaller import. Both Rust and the TypeScript bundle must
   consume that **same asset**, not separately generated OS-specific copies.
2. In `packages/plugin/src/agents/language-directive.ts`, replace both
   `Intl.DisplayNames` lookups with lookup in that table. Keep the existing
   trim/lowercase/two-letter validation, unknown-code empty result, directive
   templates, quote preservation and structural-token instructions unchanged.
   `isValidLanguageCode` must use the same table, including the currently
   supported deprecated aliases. Do not use host locale or ICU as a fallback.
3. Preserve canonical macOS bytes. Send the 17 Linux-facing name changes above
   to THALAMUS, the project's harness-bridge and tool-schema coordination owner,
   before switching TypeScript to the shared table. These changes affect
   model-visible language directives and prompt/cache identities on Linux.
   Keep the generated-name map inside the
   catalog text revision. Require an explicit reviewed table update for future
   name changes instead of allowing a Bun/ICU update to reword prompts silently.
4. Replace the ICU-generation portion of the fixture generator with canonical
   asset loading after the TypeScript builder reads it. Run real TS builders on
   both macOS and Linux against the full config/language matrix; every output
   must then be identical. Retain byte equality, rejected-code/alias coverage,
   and the guidance mutation control: change one guidance character and prove
   its exact-byte golden test fails while the other tests still pass, then
   restore the character. Test that a host ICU update
   cannot change any directive bytes. Update package asset inclusion/bundling
   checks and any hidden-agent language goldens in the same scheduled follow-up.

Until that follow-up lands, live Linux TypeScript is intentionally reported as
drifting from the canonical contract. The Linux freshness gate checks the
compiled generated table against the committed macOS capture, not live ICU;
it also checks ICU-independent tool and guidance builder outputs. No TypeScript
source or text is changed by this delivery.
