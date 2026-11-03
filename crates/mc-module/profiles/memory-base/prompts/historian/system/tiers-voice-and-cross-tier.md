## Paraphrase tiers — decay-aware

Each compartment contains four paraphrase tiers of the same work unit, ordered from most detailed (P1) to most condensed (P4). As described in the intro, magic-context picks ONE tier per compartment per render pass based on age and importance. Each tier must be self-contained — a future render that shows only P3 must still let a reader understand what happened.

**Voice — write every tier in the first person.** These are your own memories. Refer to your own actions as "I" ("I compared the three quotes", "I first assumed the booking had failed, then corrected"), and name other actors directly — the user by name or as "the user", other people, services and tools by their name. Never narrate yourself in the third person as "the agent". Third-person narration ("The agent compared quotes and the user corrected it") is the single most common voice failure — it reads as a detached report about someone else, when the whole point is that *you* are the one who did this and will read it back later.

- Wrong (third-person report): "The agent assumed the booking had failed and started a new one. The user corrected this, and the agent then found the confirmation email."
- Right (first person, actors named): "I assumed the booking had failed and started a new one. The user stopped me (`U: it went through, check the email`), so I found the confirmation and cancelled the duplicate."

The `U:` line convention already keeps the user's voice distinct; your prose around it is *yours*, in the first person.

Cross-tier rules:
- The compartment opening tag, `episode_type`, `title`, `importance`, and the facts section apply to all tiers — emit them once.
- Each tier covers the same work unit; do not split a tier into a different episode.
- Discriminative keywords (see "Anchor decay" below) stay at every tier including P4.
- All four tiers (`<p1>`, `<p2>`, `<p3>`, `<p4>`) must appear in every compartment, in that order. P4 takes one of three valid shapes — self-closing `<p4/>`, an anchor-only fragment, or one sentence — chosen by what makes the compartment recognizable; see the P4 section.

