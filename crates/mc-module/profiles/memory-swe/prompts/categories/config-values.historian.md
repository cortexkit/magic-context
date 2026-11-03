#### `CONFIG_VALUES`

**HARD STOP — before extracting any fact into CONFIG_VALUES, ask: "would this number/value change on the next build, test run, release, or measurement — without anyone making a config decision?" If yes, it is a snapshot, not config. Leave it in the compartment narrative.**

Snapshots include: artifact sizes the session measured, suite counts the session observed, dependency versions the session happened to pin, benchmark numbers, release milestones reached this session, and per-session counts of files / commits / tasks / tokens. All of these will be different on the next session and become stale memory.

CONFIG_VALUES is for values someone deliberately CHOSE and intends to remain stable: the configured threshold, the canonical path, the hardcoded constant, the schema field's allowed range.

**Test**: "Is this a DURABLE configuration value — a path, threshold, default, supported range, schema field, semantic constant — that the agent needs to reference correctly in future sessions?"

A specific value that future work needs to know exactly, AND that is intended to be stable across sessions (not a snapshot measurement).

**Preferred shape: `key: value` format.** When the fact has a natural "name of the setting" + "current value" structure, write it as `key: value`. This lets the dreamer detect later changes to the same setting. Use consistent key wording across emissions of the same setting.

**Positive examples (durable configuration)**:
- "Plugin DB path: ~/.local/share/cortexkit/magic-context/context.db" — durable path
- "execute_threshold_percentage range: 20-80, default 50" — durable knob with range and default
- "Bridge idle timeout: Infinity" — current value of a knob (was 5min earlier in this project)
- "Read command file size cap: 50KB" — durable limit
- "Read command line truncation: 2000 characters" — durable limit
- "dryRun default across all tools: false" — durable default
- "All numeric tool params: 1-based, end-inclusive" — durable semantic
- "User config path: ~/.config/opencode/aft.jsonc" — durable path
- "Hoisted tool metadata schema: { title, diff, filediff, diagnostics }" — durable schema
- "Expando character for Python/Rust AST patterns: µ (U+00B5)" — durable constant

**Negative examples (DO NOT extract as CONFIG_VALUES)**:

**Transient measurements (these change every commit/build/release — they are NOT config)**:
- "Test count: 476" — snapshot, will change every test added. **Belongs in compartment narrative if relevant to that compartment.**
- "Binary size: 7.7MB" — snapshot, changes every build.
- "ast-grep-core version: 0.41.1" — dependency version, changes on upgrade.
- "Benchmark result: 81,577 tokens, 46.7s" — one-off measurement.
- "10 SWE-bench tasks selected" — task setup for one benchmark session.

**Other category mismatches**:
- "Use OPENCODE_CONFIG env var" — too vague; specific values or schema are facts.
- "Rust crate name is agent-file-tools" — NAMING (a named entity choice).
- "Hoisted tool list: aft_outline, aft_zoom, …" — NAMING (a list of names), or just compartment narrative.

**The key test for CONFIG_VALUES**: would this value still be true in 3 months without anyone updating it intentionally? If yes (path, range, schema, semantic constant) → CONFIG_VALUES. If no (test count, binary size, dep version, benchmark snapshot) → not a fact, leave in compartment narrative.

