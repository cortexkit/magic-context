export const CTX_MEMORY_TOOL_NAME = "ctx_memory";
export const CTX_MEMORY_LIST_TOOL_NAME = "ctx_memory_list";
export const CTX_MEMORY_LIST_DESCRIPTION = "Browse active memories, optionally filter by category.";
export const CTX_MEMORY_DESCRIPTION = `Durable facts about this project, shared with every agent working on it and kept for the months this work lasts.

Your active memories are already in <project-memory> as \`#id: fact\` lines. Write one when you learn something that must not have to be found again — a project rule, an architectural fact, a hard-won constraint, a config value, a naming convention — and especially when it cost you turns to find. One standalone fact per memory, phrased to make sense on its own. A pending intention with its evidence ("do X later, here is what we know") is ctx_note, not memory.

Actions:
- write: new memory (content + category).
- update: rewrite one memory whose fact changed (ids: [one], content; category: the current one to keep, a new one to recategorize).
- archive: retire wrong or obsolete memories (ids: [one or more], optional reason).
- merge: collapse duplicates into one (ids: [two or more distinct ids of memories in the same category], content).
- get: fetch by id (ids: 1–20), readable in every status.
The call form that works on every host sends action, content, category and ids every time: argument-dropping providers only emit required fields. For get and archive pass content="" and any valid category; for write pass ids=[].
Examples: category="CONFIG_VALUES", content="OpenCode source is at ~/Work/OSS/opencode" · category="CONSTRAINTS", content="Dashboard Tauri build needs RGBA PNGs, not grayscale"`;
export const DEFAULT_SEARCH_LIMIT = 10;
