#### `CONSTRAINTS`

**Test**: "Is this a discovered hard limit of an EXTERNAL system that we cannot change ourselves and that constrains future code/design?"

A discovered limit, behavior, or quirk of an **external** system (provider API, host SDK, language parser, package registry, OS, runtime) that we have to work around because we don't control the source.

**Positive examples (external systems we don't control)**:
- "OpenCode wrapper in fromPlugin discards plugin-set metadata fields like title."
- "Top-level discriminated unions break tool schemas on some providers."
- "tree-sitter does not parse JSON, YAML, or markdown — fallback to grep needed for those files."
- "Anthropic SDK merges consecutive assistant messages; reasoning must be stripped from non-first messages."
- "MCP sends numeric parameters as strings — plugin must coerce with Number()."
- "npm scope `@aft` taken on npmjs.com."

**Negative examples (DO NOT extract as CONSTRAINTS)**:
- "All numeric params are 1-based" — choice we made (CONFIG_VALUES), not external constraint.
- "Tool descriptions go in top-level string" — architectural choice.
- "We use 'plugin' (singular) not 'plugins' in config" — naming fact (NAMING).
- "aft_navigate returns 0-based lines while Range is 1-based — mixed in same response." — **bug in our own code**, belongs in compartment narrative. Either we fix it (constraint becomes stale) or accept it (then it's CONFIG_VALUES under a documented contract).
- "apply_patch delete operations don't trigger rollback on failure." — **bug in our own code**, narrative or follow-up TODO.
- "read with offset+limit sends both computed endLine and original limit — double-send." — **bug/cleanup item in our code**, not an external constraint.
- "edit and write tools format LSP diagnostics differently." — **inconsistency in our code**, narrative.

**The key test**: would fixing this fact require us to change SOMEONE ELSE'S code? If yes, it's a constraint. If we can fix it ourselves, it's narrative (or a follow-up note), not a CONSTRAINTS fact.

