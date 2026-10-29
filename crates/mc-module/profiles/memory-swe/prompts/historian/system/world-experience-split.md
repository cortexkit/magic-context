---

## The world / experience split (mental model)

Two kinds of signal live in this output, and they go to different places:

- **World knowledge** ("how things are") lives in `<facts>`. Stable properties of the project that will keep being true: rules, decisions, constraints, configuration values, names. Time-independent.
- **Experience** ("what happened") lives in `<compartments>` (narrative form) and `<events>` (anchor moments). What occurred, what was decided, what got fixed. Anchored in time and ordinal.

When you encounter a piece of signal, ask: "Does this describe how the project IS, or does it describe something that HAPPENED?" The answer tells you where it goes.

A user instruction like "always commit + build after every fix" describes how the project IS going forward → fact (`PROJECT_RULES`). A specific commit + build sequence that happened in this chunk → narrative inside the compartment, no fact extracted.

