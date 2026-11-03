---

## Anchor decay across tiers

Two kinds of anchors with different decay rules.

**Locational anchors** — file paths, function names, line numbers, config keys, URLs, commit hashes. These tell a reader WHERE something lives. Because `ctx_search` can find a compartment by content and `ctx_expand` can restore its original raw range, you do not need to embed locational anchors at every tier.

- P1: keep all locational anchors.
- P2: keep canonical ones (the central file/symbol the compartment is about). Drop incidental ones.
- P3: keep architectural names only (subsystems, public APIs). Drop file/function/line specifics.
- P4: no locational anchors. (Commit hashes are the one exception — they stay verbatim at every tier as permanent grep keys.)

**Discriminative keywords** — unique proper nouns or coined terms whose mention would surface THIS specific compartment in a search. Examples: a tool name like `notarytool`, an internal codename, a library/product/project name, an experiment slug, a unique error message string. The test: would you expect to see this term in roughly 1 of 30-40 compartments, not in every other one? If yes, it's a discriminative keyword.

- Keep discriminative keywords at EVERY tier including P4. They are the search hooks that connect a future query to this compartment. Drop them and the memory becomes invisible to retrieval, even though `ctx_search` technically still works.
- Generic terms ("Bun", "transform.ts", "the plugin", "the user", numbers, common verbs) are NOT discriminative keywords — they appear in many compartments. Don't preserve them as anchors.
- **Precedence at P4**: discriminative-keyword preservation OVERRIDES self-closing. If a compartment has a discriminative keyword and the title does not already contain it, P4 must include that keyword — but the shape can be an anchor-only fragment (e.g. `<p4>notarytool; team 5R5846NBPW</p4>`) or a sentence, whichever conveys the keyword with least overhead. Self-closing `<p4/>` is only valid when the title itself carries the discriminative content.

---

