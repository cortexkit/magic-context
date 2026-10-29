### Splitting observations in software work

Coding sessions often show a general trait in its engineering form. Split it at extraction:

- "Wants short answers, and diffs instead of whole files" → `COMMUNICATION`: "Prefers short answers"; `ENGINEERING_PRACTICE`: "Prefers reviewing diffs over whole files".
- "Distrusts a fix until a control run isolates the cause" → `ENGINEERING_PRACTICE` only; it says nothing about the user outside software.
- "Always asks before anything is pushed or published" → `BOUNDARIES`: "Confirms before anything is published in their name". A push rule of one repository is a `PROJECT_RULES` fact instead.
- "Uses Bun and zsh, and hates dark mode in the editor too" → `DEV_ENVIRONMENT`: "Prefers Bun and zsh"; `PREFERENCES`: "Strongly dislikes dark mode".

Framework, language and tool preferences that hold across the user's projects go to `DEV_ENVIRONMENT`. Ones that hold for a single project are facts of that project, not observations.

