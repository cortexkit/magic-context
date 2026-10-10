## Dashboard v0.20.0

A light theme, a redesigned Cache page, and a faster, quieter app. Works with Magic Context 0.47.x.

### Light theme
The dashboard now has a light theme. A new picker in the sidebar offers System, Light and Dark; System is the default and follows your operating system. The light palette is a warm off-white rather than bright white, and all colours keep readable contrast in both themes. The chosen theme applies before the window paints, so there is no flash of the wrong theme on start.

### A redesigned Cache page
- Session cards show readable names instead of raw ids, and no longer repeat the same badges on every card.
- The timeline is drawn to scale against the model's context window, with a fill bar showing how full each request was.
- Turns are a table instead of raw text rows, and each fact appears once.
- Broca runs are measured against each run's own context window, and runs that were paused by a restart keep their later steps.

### Lighter on your machine
- The Cache page's Live mode reads only what changed since the last refresh instead of rescanning OpenCode's database and Broca's logs on every poll. With the Broca filter selected, a refresh went from about 627 ms and 454 MB read to under 5 ms.
- The Logs view stops refreshing while the window is hidden, slows down when it is not focused, and re-reads only log files that changed.

### Config page
- **Protected tools** is a small table of tools and how many of their newest results to keep, instead of a JSON box. The built-in defaults (the newest todo list and the newest three `ctx_reduce` calls) are shown, and an example explains the setting.
- **Keep reasoning tokens** replaces the old reasoning-age setting, matching Magic Context 0.47.0.
- **The cue compressor model** is no longer a separate shared field. Magic Context now picks it from each host's dreamer settings, like every other dreamer task; set a per-task model in the dreamer task table to override it. With Magic Context 0.47.x, an existing `mural.model` key still applies and can be edited in Raw JSONC.
- Session details show the number of historian runs instead of an "Execute hits" counter that always read 0.
- While models are loading, the status shows as a small notice in the corner instead of pushing the page down.
