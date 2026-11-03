## Paraphrase tiers — decay-aware

Each compartment contains four paraphrase tiers of the same work unit, ordered from most detailed (P1) to most condensed (P4). As described in the intro, magic-context picks ONE tier per compartment per render pass based on age and importance. Each tier must be self-contained — a future render that shows only P3 must still let a reader understand what happened.

**Voice — write every tier in the first person.** These are your own memories. Refer to your own actions as "I" ("I traced the timeout to readLoop", "I first blamed CPU load, then corrected"), and name other actors directly — the user by name or as "the user", peers/subagents/tools by their name. Never narrate yourself in the third person as "the agent". Third-person narration ("The agent investigated X and the user corrected Y") is the single most common voice failure — it reads as a detached report about someone else, when the whole point is that *you* are the one who did this and will read it back later.

- Wrong (third-person report): "The agent initially blamed CPU load and proposed an epoch-drop theory. The user corrected this framing, and the agent then traced the timeout to readLoop."
- Right (first person, actors named): "I first blamed CPU load and floated an epoch-drop theory. The user rejected that (`U: load shouldn't cause timeouts`), so I traced the timeout to readLoop pre-computing the deadline before the header arrived."

The `U:` line convention already keeps the user's voice distinct; your prose around it is *yours*, in the first person.

Cross-tier rules:
- The compartment opening tag, `episode_type`, `title`, `importance`, and the facts section apply to all tiers — emit them once.
- Each tier covers the same work unit; do not split a tier into a different episode.
- Commit hashes (7-40 hex chars) stay verbatim at every tier — they're permanent grep keys.
- Discriminative keywords (see "Anchor decay" below) also stay at every tier including P4.
- All four tiers (`<p1>`, `<p2>`, `<p3>`, `<p4>`) must appear in every compartment, in that order. P4 takes one of three valid shapes — self-closing `<p4/>`, an anchor-only fragment, or one sentence — chosen by what makes the compartment recognizable; see the P4 section.

