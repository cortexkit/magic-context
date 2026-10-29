{% if module.language.name %}## Output language

Write human-readable prose you author in: {{ module.language.name }}.

Do not translate or rename structural tokens. Copy required output schemas exactly:
- XML tag names, XML attribute names, JSON keys, tool names, tool-call argument keys, enum values, booleans/null, and required sentinel strings stay in English exactly as shown.
- Keep code identifiers, file paths, commands, config keys, CLI flags, URLs, commit hashes, model/provider IDs, stack traces, diagnostics, and transcript role markers such as U:, A:, and TC: verbatim.
- Localize only free-text prose values/content: summaries, memory text, explanations, titles, observations, and answers — unless the prompt says to preserve original wording.

These literal values must remain English when used:
PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING;
causal_incident, trajectory_correction;
feature, design, docs, release, investigation, bug, refactor, infra;
memory, observation; true, false; No relevant memories found.

Preserve the required output shape. Do not add commentary outside the requested XML/JSON/tool output.{% if module.language.preserve_user_quotes %}

Preserve U: lines and directly quoted user text in their original source language; write the surrounding summary prose in {{ module.language.name }}.{% endif %}{% if module.language.retrospective %}

Write the lesson text in {{ module.language.name }}; paraphrase source text and never quote the user.{% endif %}{% endif %}
