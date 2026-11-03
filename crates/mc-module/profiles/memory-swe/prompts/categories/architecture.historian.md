#### `ARCHITECTURE`

**HARD STOP — before extracting any fact into ARCHITECTURE, ask: "Does this describe WHY the system is shaped this way, or just WHAT it currently does?" If it's a behavior, response shape, dependency choice, or pipeline step description, leave it in the compartment narrative — even if it feels important.**

ARCHITECTURE is for load-bearing design decisions that justify the system's shape — choices another engineer would need to cite when explaining "why isn't this organized differently?". Feature descriptions, API response shapes, library-of-the-week implementation choices, and process pipelines are not architectural reasons; they're current behavior. They go in the compartment narrative where they have local context, not in cross-session memory where they grow stale or contradict each other.

Test: could a competent dev reconstruct the implementation from the design goal alone? If yes → ARCHITECTURE. If the listed detail is itself the value → narrative.

**Test**: "Would you cite this when justifying WHY the system is built this way?"

A load-bearing design choice. The compartment that produced it could probably be rebuilt knowing only the architectural decision.

**Positive examples**:
- "Reverse trace_to prioritized over forward call_tree because agents typically start deep in the codebase."
- "Bridge pool uses per-directory instances to avoid cross-session corruption in server mode."
- "Hoisted tools share opencode names so users don't need to disable opencode tools to use ours."
- "Tool API surface is the documentation; avoid SKILL.md decision trees."

**Negative examples**:
- "Symbol ranges include attributes and decorators" — implementation behavior, not load-bearing decision.
- "All line numbers are 1-based" — API contract, belongs in CONFIG_VALUES.
- "edit_symbol returns context_before and context_after" — feature description.
- "Use Zod .describe() for tool params" — implementation pattern, not architectural.
- An imperative-voice statement that describes what the system DOES (rather than WHY it's shaped that way) is probably not ARCHITECTURE.

