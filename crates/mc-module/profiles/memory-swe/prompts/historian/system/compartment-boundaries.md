---

## Compartments — boundaries

A compartment is one contiguous arc of work with a single objective. The objective is *what the work was for*, not the activities used to achieve it.

### Boundary signal: pivot in objective, not change in activity type

A compartment may span design → implementation → fixes → docs → commit → release if all of those steps served the same objective. Activity types changing within an arc do not split the compartment — they are stages of one work unit.

Examples of one compartment:
- **"Add markdown outline support"** — includes design discussion, tree-sitter dependency upgrade, implementing the extractor, fixing affected tests, writing markdown integration tests, committing, pushing. One objective: add markdown support. Spans design, refactor, feature, infra, docs, release activities. All one compartment.
- **"Hardened the release pipeline"** — includes auditing the pipeline, fixing repo URLs across six files, restructuring CI workflow, adding test gates, writing a release script, settling the npm scope and crate name. One objective: get the release pipeline production-ready. Spans infra, refactor, design activities. All one compartment.
- **"Investigated and fixed the hoisted edit failures"** — includes inspecting failed sessions, identifying both routing bugs, attempting compatibility fixes, recognizing the deeper design issue, deciding to split hoisted edit from aft_edit. One objective: figure out why agents fail with hoisted edit. Spans investigation, bug, refactor, design activities. All one compartment.

Examples requiring two compartments:
- **"Fixed the scheduler bug"** then **"Started designing the new sidebar API"** — distinct objectives.
- **"Restructured into a monorepo"** then **"Built the AFT downloader"** — distinct objectives, second wasn't pre-planned as part of the first.
- **"Released v0.21.0"** then **"Began the v0.22 redesign work"** — distinct objectives separated by a clear ship-and-pivot moment.

### Smaller boundary clues

- The user explicitly redirects with "okay now let's move to X" or "next we need Y" — usually a new objective.
- The work transitions from build → commit → push within the same arc — usually still one objective (build-and-ship-X), not two.
- A multi-step investigation that resolves into a fix in the same arc is one compartment, not separate "investigation" + "bug" compartments.
- Quick housekeeping (gitignore update, lint fix) inside a larger arc folds INTO that arc, not a separate compartment.
- A long pause where the user changes topic completely is a boundary even if the previous arc didn't fully "finish".

