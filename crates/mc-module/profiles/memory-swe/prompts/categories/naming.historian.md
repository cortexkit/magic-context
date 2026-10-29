#### `NAMING`

**HARD STOP — before extracting any fact into NAMING, ask: "Is this a NAMING CONVENTION or RENAME that future work needs, or is it an INVENTORY of names that currently exist?" If it's an inventory of current names — tools, modules, components, packages, endpoints, feature flags — leave it in the compartment narrative.**

Inventories of current names are not naming facts. The agent already sees its available tools through its tool definitions, the codebase shows current module/component/endpoint names through normal exploration, and the package registry shows package lists. Listing them as cross-session facts adds noise without adding signal.

What IS a NAMING fact: the convention itself (a prefix pattern, a case style, a renaming decision), and the reasoning behind a non-obvious choice (e.g. "we used X instead of Y because Y was taken"). Extract the pattern, not the population.

**Test**: "Is this a naming convention, prefix/suffix pattern, or an intentional rename that future work needs to know to use the right name?"

NAMING captures **conventions and renames**, not inventories of current names.

**Positive examples (conventions, renames, rejected alternatives)**:
- "Hoisted tools share opencode names: read, write, edit, apply_patch."
- "aft_ prefix used for non-hoisted tools when hoist_builtin_tools=false."
- "Parameter name is filePath (not file) for opencode UI compatibility."
- "Plural form is 'plugin' in opencode config (not 'plugins')."
- "Rust crate name: agent-file-tools (because 'aft' is taken on crates.io)."
- "npm scope: @cortexkit (because @aft is taken)."
- "Parameter renamed: scope → container (in aft_transform)."
- "All tool parameters use camelCase (matching opencode built-in convention)."

**Negative examples (DO NOT extract as NAMING)**:

**Current tool/component lists are NOT naming facts**:
- "Consolidated tool names: aft_outline, aft_zoom, aft_navigate, aft_edit, …" — list of current tools, not a convention. The agent learns these from its tool definitions. **Belongs in compartment narrative if the list itself is what the compartment is about; otherwise drop.**
- "LSP tool names: aft_lsp_diagnostics, aft_lsp_hover, …" — same.
- "Dropped tools: aft_lsp_hover, aft_lsp_goto_definition, …" — narrative.
- "Feature names: checkpoint, restore_checkpoint, move_symbol, …" — function inventory, narrative.

**Other category mismatches**:
- "Rename happened in commit X" — event, captured in compartment narrative.
- "The fix was to rename Y" — action, not a naming fact (only the convention or resulting name is a fact).

**The key test for NAMING**: would the agent get a name wrong in a future session without this fact? Conventions (camelCase, aft_ prefix, plural 'plugin') answer YES. Lists of current tool names answer NO — the agent already sees them in its tool definitions.

