# CK session extensibility: coverage of the 20 most-adopted OpenCode and Pi plugins

Tests `.cortexkit/alfonso/plans/ck-extensibility-design.md` (DRAFT r2) against real plugin source. For each plugin: which host surfaces it uses, which CK mechanism would carry each capability, a verdict, and what is missing.

- Research only. Nothing was installed into a live host config, and no plugin was run. Source was read from shallow clones under `$TMPDIR/magic-context/plugcov/src/`.
- Read on 2026-09-26. npm download numbers are for the week 2026-09-18 to 2026-09-24 (`api.npmjs.org/downloads/point/last-week/<pkg>`). GitHub stars were read with `gh api repos/<owner>/<repo>` on 2026-09-26.
- Host surfaces are not re-derived here. `.cortexkit/alfonso/reviews/extension-landscape-survey.md` ("the survey") documents them, and this report cites its sections.
- The hook classes (1 catalog shaping, 2 request decoration, 3 tool-call intercept, 4 result decoration, 5 observe) come from `broca/docs/plugin-hooks-engine-design.md` ("plugin-hooks"). The design doc refers to them in §7.7 and §11.
- Section numbers like §6.2 point into the design doc unless marked "survey §" or "plugin-hooks".

## 1. How the 20 were picked

### 1.1 Method

1. **Candidate pool.** Every npm package with the keyword `opencode-plugin` (2,109 packages), `pi-package` (10,703), `pi-extension` (5,218) or `pi-coding-agent` (2,481), read through the npm search API. Added to that: every entry in OpenCode's `ecosystem.mdx` (fetched from `anomalyco/opencode@dev`), `awesome-opencode/awesome-opencode` README, `pi.dev/packages` (the gallery sorts by downloads, and its order matches npm), and an npm text search for "opencode plugin" and `keywords:opencode`. The text search found packages that don't carry the plugin keyword, such as `oh-my-openagent` and `@langfuse/opencode-observability-plugin`.
2. **Exclusions** (Table 1.4):
   - CortexKit packages (none reached the top of either list);
   - packages OpenCode bundles as dependencies, whose downloads come from OpenCode installs (`opencode@v1.18.32:packages/opencode/package.json:82,135-136` pins `opencode-gitlab-auth`, `opencode-poe-auth`, `@gitlab/opencode-gitlab-auth`; `opencode-anthropic-auth` and `opencode-copilot-auth` are the other built-in auth plugins, survey §1.1);
   - things that aren't extensions (a CLI agent built on Pi, an ACP adapter, a UI library);
   - packages whose downloads have no second signal: fewer than 100 GitHub stars, or no repository.
3. **Ranking:** the geometric mean √(weekly downloads × stars). Neither signal is enough alone:
   - `opencode-models-discovery` has 191,008 downloads a week and 164 stars, and its daily counts swing between 0 and 58,000 (`api.npmjs.org/downloads/range/last-month`), which suggests mirrors or CI;
   - `@dietrichgebert/ponytail` has 146,188 stars that cover a multi-host skills product.

   The geometric mean damps both.
4. **One package, one list.** A package published for several hosts goes on one list only: `ponytail` (both keywords) on OpenCode, `context-mode` (keyword `pi-package` only) on Pi. Plannotator ships two separate npm packages (`@plannotator/opencode`, `@plannotator/pi-extension`) with separate download counts, so it appears once on each list.

**Caveat.** Stars belong to a repository, not a package. `@openviking/opencode-plugin` (umbrella repo `volcengine/OpenViking`), `@ff-labs/pi-fff` (`dmtrKovalenko/fff`), plannotator and the two `rpiv-mono` packages inherit stars from a larger repo. They are flagged "(umbrella)" below. Dropping umbrella stars would swap `@openviking/opencode-plugin` out for `opencode-openai-codex-auth` and `@ff-labs/pi-fff` out for `@rynfar/meridian`, and no conclusion in §4 or §5 changes.

### 1.2 OpenCode: top 10

| # | Package | Repo (commit read) | Weekly dl | Stars | √(dl×★) | Purpose |
|---|---|---|---|---|---|---|
| 1 | `@dietrichgebert/ponytail` 4.10.0 | DietrichGebert/ponytail (`e3ba2aa`) | 18,944 | 146,188 | 52,627 | "Lazy senior dev" ruleset injected every turn, with modes and skills; one package for OC, Pi and many other hosts |
| 2 | `oh-my-openagent` + `oh-my-opencode` 4.19.4 (same code) | code-yeongyu/oh-my-openagent (`345572d`, HEAD is 5.0.0-beta.90) | 24,358 + 14,694 | 69,433 | 52,072 | Batteries-included harness: curated agents, background agents, LSP/AST tools, ~70 hooks |
| 3 | `oh-my-opencode-slim` 2.2.25 | alvinunreal/oh-my-opencode-slim (`2e82dc5`) | 15,249 | 9,062 | 11,755 | Lighter orchestration fork: agent roster, task delegation, presets, guards |
| 4 | `@openviking/opencode-plugin` 2026.9.25-2 | volcengine/OpenViking `examples/opencode-plugin` (`a09a9d2`) | 2,304 | 38,703 (umbrella) | 9,443 | Long-term memory and repo retrieval backed by an OpenViking server |
| 5 | `@tarquinen/opencode-dcp` 3.2.0 | Opencode-DCP/opencode-dynamic-context-pruning (`f8232fd`) | 15,608 | 4,270 | 8,164 | Dynamic context pruning: a `compress` tool plus history rewriting (listed in `ecosystem.mdx`) |
| 6 | `opencode-models-discovery` 1.6.1 | yuhp/opencode-models-discovery (`6e03fa5`) | 191,008 | 164 | 5,597 | Auto-discovers OpenAI-compatible models into provider config |
| 7 | `@plannotator/opencode` 0.27.20 | backnotprop/plannotator `apps/opencode-plugin` (`0560d59`) | 3,288 | 8,958 (umbrella) | 5,427 | Plan mode with browser review and annotation of plans (listed in `ecosystem.mdx`) |
| 8 | `opencode-antigravity-auth` 1.6.0 | NoeFabris/opencode-antigravity-auth (`16e0056`) | 2,663 | 10,976 | 5,406 | Google Antigravity OAuth provider (listed in `ecosystem.mdx`) |
| 9 | `opencode-gemini-auth` 2.0.1 | jenslys/opencode-gemini-auth (`0836e20`) | 3,421 | 1,758 | 2,452 | Gemini subscription OAuth provider (listed in `ecosystem.mdx`) |
| 10 | `opencode-mem` 2.26.0 | tickernelz/opencode-mem (`cec1de4`) | 2,495 | 1,688 | 2,052 | Local vector memory with automatic recall and capture, plus a web UI |

Next in line: `opencode-openai-codex-auth` (1,886), `opencode-claude-auth` (1,812), `@slkiser/opencode-quota` (1,711), `opencode-pty` (1,670), `opencode-supermemory` (1,550).

### 1.3 Pi: top 10

| # | Package | Repo (commit read) | Weekly dl | Stars | √(dl×★) | Purpose |
|---|---|---|---|---|---|---|
| 1 | `pi-subagents` 0.71.0 | nicobailon/pi-subagents (`2e9c51b`) | 132,761 | 3,766 | 22,360 | Subagent delegation, chains and async runs as child Pi processes |
| 2 | `context-mode` 1.0.169 | mksglu/context-mode (`da08c30`) | 18,925 | 24,076 | 21,346 | Sandboxed execute and index tools plus a session event store, to keep raw output out of context; multi-host |
| 3 | `pi-mcp-adapter` 2.37.0 | nicobailon/pi-mcp-adapter (`7bf2332`) | 277,551 | 1,548 | 20,728 | Adds MCP to Pi (which has none built in): proxy tool, direct tools, OAuth, consent, MCP UI apps |
| 4 | `@plannotator/pi-extension` | backnotprop/plannotator `apps/pi-extension` (`0560d59`) | 28,182 | 8,958 (umbrella) | 15,889 | Plan mode, browser plan review, code review |
| 5 | `pi-web-access` 0.31.0 | nicobailon/pi-web-access (`610a520`) | 123,649 | 1,538 | 13,790 | Web search, fetch, PDF and video tools, plus a browser "curator" |
| 6 | `@ff-labs/pi-fff` 0.11.0 | dmtrKovalenko/fff `packages/pi-fff` (`708d57b`) | 11,386 | 10,868 (umbrella) | 11,124 | Native fuzzy file and content search tools that can replace Pi's `grep`/`find` |
| 7 | `@juicesharp/rpiv-ask-user-question` 2.11.0 | juicesharp/rpiv-mono (`d74b1c9`) | 59,000 | 836 (umbrella) | 7,023 | A tool that puts a structured questionnaire to the user |
| 8 | `gentle-engram` 0.1.16 | Gentleman-Programming/engram `plugin/pi` (`3692e1a`) | 7,146 | 6,854 | 6,998 | Persistent memory backed by a local `engram` server |
| 9 | `@juicesharp/rpiv-todo` 2.11.0 | juicesharp/rpiv-mono (`d74b1c9`) | 37,977 | 836 (umbrella) | 5,635 | A todo tool for the model, with a live overlay |
| 10 | `billion-context` 0.1.155 | ranxianglei/billion-context (`38ec022`) | 79,707 | 296 | 4,857 | Context compression through a local proxy on the model API; multi-host |

Next in line: `@rynfar/meridian` (3,678), `cc-safety-net` (3,544), `@narumitw/pi-usage` (3,437), `pi-lens` (3,060), `pi-powerline-footer` (2,903).

Pi has well over 10 real candidates, so no shortfall to report.

### 1.4 Excluded despite high numbers

| Package | Weekly dl | Stars | Reason |
|---|---|---|---|
| `opencode-gitlab-auth`, `opencode-poe-auth`, `opencode-anthropic-auth`, `opencode-copilot-auth` | 158,951 / 158,718 / 134,191 / 8,853 | — | bundled by OpenCode itself |
| `opencode-usage-quota-tracker`, `opencode-model-recommender` | 65,703 / 65,624 | 0 / 0 | alpha packages created 2026-09-08 whose repos have no stars; downloads not corroborated |
| `rolebox` | 6,673 | 2 | not corroborated |
| `@langfuse/opencode-observability-plugin`, `@langfuse/pi-observability-plugin` | 66,684 / 127,755 | 31 / 10 | not corroborated. Surfaces are lifecycle observation (survey §7 "Observability"), which maps to class 5 |
| `openrtk` | 3,784 | repo 404 | no repository |
| `superpowers` (OpenCode) | — | 291,812 | installed as `superpowers@git+https://github.com/obra/superpowers.git` (its `.opencode/INSTALL.md:17`), so there's no OpenCode-specific download signal, and its stars mostly reflect Claude Code use. Its surfaces are in survey §7 |
| `@companion-ai/feynman` | 38,178 | 9,791 | a CLI agent built on Pi, not an extension |
| `pi-acp` | 43,166 | 703 | ACP adapter that runs Pi, not an extension |
| `@narumitw/pi-tui-kit` | 45,835 | 622 | UI library that extensions import |
| `pi-mcp-extension`, `agent-comms`, `pi-goal-x` | 42,454 / 16,429 / 30,260 | 8 / 25 / 75 | not corroborated |

## 2. Verdict vocabulary

- **Covered:** writable today as a CK extension from what the design specifies.
- **Covered with work:** the design allows it, but a named piece isn't specified yet (an open item in §12, the class 3 rule vocabulary, and so on).
- **Gap:** the design can't express the plugin's core behaviour, or forbids it. Each gap is tagged:
  - **(a)** a deliberate exclusion the design justifies;
  - **(b)** an omission to add;
  - **(c)** out of scope for a session-extension design.

A plugin's verdict is for its **model-facing core**. Commands, TUI and editor UI are listed per plugin as (c) and don't set the verdict on their own, because §11 puts "commands, UI" out of scope for v1.

## 3. Per-plugin analysis

In the surface lists, "state" means the plugin keeps durable state of its own, "proc" that it spawns processes, "net" that it calls the network, "UI" that it renders UI, and "cmd" that it adds slash commands. Paths are relative to the plugin repo at the commit given in §1.

### OC-1 `@dietrichgebert/ponytail`

**Surfaces**
- OpenCode (`.opencode/plugins/ponytail.mjs`):
  - `config` (`:55`) registers commands from `.opencode/command/*.md` and adds a skills path;
  - `experimental.chat.system.transform` (`:74`) appends mode-dependent instructions to the **last existing system entry** every request;
  - `command.execute.before` (`:89`) writes the mode to `~/.config/opencode/.ponytail-active`.
- Pi (`pi-extension/index.js`):
  - `registerCommand` ×6 (`:114-169`);
  - `input` (`:174`) turns "stop ponytail" typed by the user into mode off;
  - `session_start` (`:183`) restores the mode from branch entries;
  - `appendEntry` (`:96`);
  - `before_agent_start` (`:204`) appends the ruleset to `systemPrompt`;
  - `ctx.ui.setStatus`/`notify`.
- State: a global mode file (OC) or session entries (Pi). No proc, no net. UI: status (Pi). Cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Ruleset text, one per mode (lite/full/ultra) | three presets with static system text (R1: "a variant is another preset"), plus an operator-text grant (§6.3) | Covered |
| Where the text goes | fixed order persona → module text → host notes (§6.4). Appending into the host's last system entry is replaced by the module's own ordered slot | Covered (the OC behaviour is correctly dropped) |
| Mode switch mid-session by `/ponytail full` or by typing "stop ponytail" | nothing. Presets are picked by prefrontal's table (§6.1), activation is prefrontal's decision at a run boundary (§6.5), and neither users nor modules have a way to ask for a different preset | **Gap (b)**, see G1 |
| Skills directory (catalog in the prompt, body read on demand) | no skill contribution kind. The catalog could be static system text and the bodies files the model reads with a host tool, but §5.3 lists only "system text, MCP tool sources, replaced slots" | Covered with work (G9) |
| Commands, status line | out of scope (§11, §12) | (c) |

**Verdict: Covered with work.** It's a clean declarative extension (§5.3, §10 "third-party persona") as long as the mode is fixed per preset. Switching mode in-session (G1) is a Gap (b).

### OC-2 `oh-my-openagent` / `oh-my-opencode`

**Surfaces** (`packages/omo-opencode/src/plugin-interface.ts:37-105`, plus `experimental.session.compacting` and `experimental.compaction.autocontinue` wired in `src/testing/create-plugin-module.ts` per `src/AGENTS.md:33`):
- `tool` (`tools/`: `delegate-task`, `background-task`, `hashline-edit`, `grep`, `glob`, `interactive-bash`, `look-at`, `skill`, `skill-mcp`, `monitor`, `session-manager`, `task`, `slashcommand`);
- `chat.params` (`:39`, think-mode reasoning variants, `hooks/think-mode/switcher.ts`);
- `chat.headers` (`:61`);
- `command.execute.before` (`:63`);
- `chat.message` (`:68`: keyword detector, model fallback, `hooks/model-fallback/chat-message-fallback-handler.ts`);
- `experimental.chat.messages.transform` (`:75`);
- `experimental.chat.system.transform` (`:79`);
- `config` (`:85`: agents, commands, MCP);
- `event` (`:87`);
- `tool.definition` (`:95`, overrides the built-in `todowrite` description, `hooks/todo-description-override`);
- `tool.execute.before` and `tool.execute.after` (`:99`, `:105`).

About 100 hook entries sit under `src/hooks/`. The ones that matter here:
- `rules-injector` and `directory-agents-injector`: `tool.execute.after` appends matching rule or AGENTS.md files to read results (`hooks/rules-injector/hook.ts:112`);
- `comment-checker`: spawns a native binary after edits (`hooks/comment-checker/cli.ts:1,149`);
- `tool-output-truncator.ts`;
- `todo-continuation-enforcer` and `ralph-loop`: re-prompt the session when it goes idle with open todos (`continuation-injection.ts`, `continuation-prompt-injector.ts`);
- `preemptive-compaction*.ts`, `compaction-context-injector`, `compaction-todo-preserver`;
- `claude-code-hooks`: runs the user's Claude Code shell and HTTP hooks (`dispatch-hook.ts`, `execute-http-hook.ts`);
- `session-notification*` (desktop notifications);
- `tmux-core` panes.

State: yes. Proc: yes (LSP, ast-grep, comment-checker, tmux, subagents). Net: yes (auto-update). UI: TUI (`src/tui.ts`). Cmd: yes. Survey §7 lists the same surfaces for the 1.x line.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Curated agents (Sisyphus and others) with prompts and models | personas plus the composition table (§6.1). Personas pick a class, and the table picks presets. A module can't ship personas. A declarative extension carries only "system text, MCP tool sources, replaced slots" (§5.3), not a class or model | Gap (b), G7 |
| LSP, AST, hashline-edit tools that replace edit/read/grep | preset tools plus `replaces_slots` (§4, §6.2 exclusive slots, the §10 AFT example) | Covered |
| Background and delegate tasks with completion wakes | the tool runs in the module. Completions are `provider_notice` with a per-event `notice_id` (§7.4). Whether a notice starts a turn on an idle session is unspecified | Covered with work (G4) |
| System and messages transforms (reminders, context injection) | static text goes in a preset (§6.3), turn reminders in §7.5, per-session values in the untrusted carrier (§7.3). History rewriting belongs to the single reduction owner (§6.6), so a guidance plugin can't also rewrite history | Covered for reminders. (a) for rewriting |
| Rules and AGENTS.md injected into read results; tool-output truncation | class 4 "decorate once and persist" (§7.7, plugin-hooks "Declarative application"), but class 4 is **rendered from durable supplier state**, not computed per call from the file path read. Computing it per call is code on the step path, which §7.8 forbids ("No module code runs on the step path") | Gap (a), G5. Workaround: own the `read` slot (`replaces_slots`) and decorate inside the tool |
| Comment checker: a binary run after each edit | code per tool call: (a) unless the module owns the edit slot, in which case it's tool internals | (a) / Covered via `replaces_slots` |
| Todo-continuation and ralph loop (re-prompt on idle) | nothing. `provider_notice` is for asynchronous results; no "stop/continue" hook exists (survey §8 lists it as a common request) | Gap (b), G4 |
| think-mode (`chat.params`), model and runtime fallback | model, reasoning and retry routing belong to persona and route selection, not session extensions (§11 "providers, models, auth: out of scope") | (c). Whether a preset may declare generation parameters is open (Q6) |
| Overriding the built-in `todowrite` description (`tool.definition`) | principle 1 ("no other party … second-guesses them"). The sanctioned path is `replaces_slots` with its own `todowrite` | (a) |
| Compaction context injection and todo preservation | when host compaction is the reduction owner (§6.6) a non-owner can't feed it. A post-compaction `provider_notice` would work if compaction were an observable class 5 event with a defined placement | Covered with work (G6) |
| Running the user's Claude Code shell hooks per tool call | arbitrary code in class 3/4. plugin-hooks: "No arbitrary computed class-3 rewrites in v1" | (a) |
| Desktop notifications, tmux panes, TUI | class 5 observe for notifications (host UI side); panes and TUI (c) | Covered (observe) / (c) |

**Verdict: Gap.** The model-facing core (agents, tools, reminders, notices) maps. Personas shipped by a module (G7), continuation loops (G4) and computed per-call decoration (G5) don't. G5 is a deliberate exclusion.

### OC-3 `oh-my-opencode-slim`

**Surfaces** (`src/index.ts`):
- `agent` and `tool` and `mcp` in the returned object (`:1210-1216`; MCP `context7`, `grep-app` in `src/mcp/`);
- `config` (`:1218`), `event` (`:1559`);
- `tool.execute.before` (`:1864`): chains `apply-patch`, `absolute-path-rescue` (rewrites guessed absolute paths), `search-path-guard` (blocks grep/glob on missing paths), task-session manager and `tool-loop-guard` (blocks repeated identical reads, `src/hooks/tool-loop-guard/hook.ts:33,243`);
- `command.execute.before` (`:1891`: interview, deepwork, reflect, loop commands);
- `chat.headers` (`:1929`), `experimental.session.compacting` (`:1933`), `chat.message` (`:1939`);
- `experimental.chat.system.transform` (`:2078`);
- `experimental.chat.messages.transform` (`:2143`): phase reminder, skills filter, **image stripping by model capability**, background job board;
- `tool.execute.after` (`:2227`);
- OpenCode 2 `setup` (`:2248`);
- a `preset-switch` tool that rewrites agent models (`src/tools/preset-switch.ts`);
- orchestrator wake by `promptAsync` (`src/hooks/orchestrator-wake/`);
- foreground model fallback (`v2.session.retry`, `:1209`);
- tmux multiplexer, TUI (`src/tui.ts`).

State, proc, net, UI and cmd: yes. Survey §7 already recorded the `/preset` command and `chat.headers`.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Agent roster with per-agent prompts and tools | composition table and personas (§6.1). Module-shipped personas aren't expressible | Gap (b), G7 |
| Delegation tools (task, status, reply, revive) and orchestrator wake | module tools plus `provider_notice` (§7.4). Waking an idle parent is unspecified | Covered with work (G4) |
| Path rescue and loop guard | computed, stateful class 3 rewrites. plugin-hooks allows only declarative rewrite templates and deny rules | (a), G5 |
| Search-path guard (deny grep/glob on a non-existent path) | the deny needs a filesystem check. A declarative rule can't express "path exists" | (a) |
| Phase reminder | turn-scoped reminder (§7.5) | Covered |
| Image stripping per model capability | rewrites the current user turn. It isn't a preserving pipeline stage (§6.6), no reducer should do it, and no input-rewrite class exists | Gap (b), G8 |
| `preset-switch` tool: the model or user changes agents' models mid-session | model routing (c) plus mid-session preset change (G1) | (c) / Gap (b) |
| `chat.headers`, model fallback | provider routing (§11) | (c) |
| Interview and deepwork commands, tmux, TUI | §11, §12 | (c) |

**Verdict: Gap**, for the same reasons as OC-2 (G1, G5, G7, G8).

### OC-4 `@openviking/opencode-plugin`

**Surfaces** (`examples/opencode-plugin/index.mjs`):
- `config` (`:30`) injects an MCP server (`lib/mcp-config.mjs`);
- `event` (`:42`) syncs the session to the OpenViking server (`lib/memory-session.mjs`);
- `tool.execute.before` (`:49`, `lib/viking-uri-guard.mjs`) throws when `viking://` URIs are passed to filesystem tools;
- `tool.execute.after` (`:50`) appends a notice to shell output;
- `experimental.chat.system.transform` (`:52`) pushes a repo list built at runtime (`lib/repo-context.mjs`);
- `chat.message` (`:57`) injects session context and recalled memories into the user message (`lib/memory-recall.mjs`, `lib/session-inject.mjs`);
- `experimental.session.compacting` (`:76`) flushes the session on compaction;
- OpenCode 2 variant `lib/v2-plugin.mjs`.

State: server-side. Net: yes. No UI, no cmd.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| OpenViking MCP tools | tools from a running module, or MCP tool sources in a declarative file (§5.3) | Covered |
| URI guard (deny on an argument pattern) | class 3 declarative deny rule (§11 row "tool-call intercept") | Covered with work: the rule vocabulary (argument regex or prefix) isn't specified anywhere (Q4) |
| Notice appended to shell output | class 4 decoration, but computed from the call's arguments (G5) | (a), unless it's a static template keyed on a matched pattern (Q4) |
| Repo list in the system prompt | per-session value, so the untrusted carrier (§6.3, §7.3). It loses operator authority, which is correct | Covered |
| Per-prompt recall injected into the user turn | the design's only per-run code seam with request bytes is class 2 request decoration (§7.5 "class 2 tail decoration", plugin-hooks class 2). Its authority isn't in the §8 table, and §7.5 calls it "never persisted", so recall would vanish from history after the run and cost cache on every later request | Covered with work, G2 |
| Session sync and compaction flush | class 5 observe (§11). Needs message content and a compaction event in the stream (Q5) | Covered with work |

**Verdict: Covered with work** (G2, Q4, Q5).

### OC-5 `@tarquinen/opencode-dcp`

**Surfaces** (`index.ts` hook map; `lib/hooks.ts`):
- `experimental.chat.system.transform` (`createSystemPromptHandler`, `lib/hooks.ts:58`): the text depends on permission and sub-agent state;
- `experimental.chat.messages.transform`: prunes and compresses history and injects nudges (`lib/messages/prune.ts`, `lib/messages/inject/inject.ts:33`);
- `experimental.text.complete` (`lib/hooks.ts:292`): strips hallucinated tags from assistant text before it's saved;
- `command.execute.before` (`/dcp` commands: `lib/commands/{context,decompress,recompress,stats,sweep,manual}.ts`, which reply with ignored messages via `lib/ui/notification`);
- `event` (`lib/hooks.ts:301`, tracks `compress` tool part state);
- `tool.compress` (message or range mode);
- `config` (adds a command, `experimental.primary_tools`, a `compress` permission);
- OpenCode 2 (`lib/v2/index.ts:168-174`: `model.transform`, `session.hook("context"|"compaction")`, `tool.transform`, `command.transform`; the TUI in `lib/v2/tui.tsx`).

State: yes (`lib/state/persistence.ts`). Net: npm auto-update (`lib/update.ts:132`). UI: TUI (v2). Cmd: yes. Survey §7 lists the v1 surfaces.

**Mapping.** DCP is the closest analogue of Magic Context's own §10 example.

| Capability | CK mechanism | Status |
|---|---|---|
| Pruning and compression of history | reduction owner (§6.6, §7.7), with protected spans and replay determinism | Covered with work: the transform interface is specified only for Magic Context (§6.6 "v1 ships the reducer only"); see Q3 |
| `compress` tool | preset tools (§4) | Covered |
| System text that varies by sub-agent and permission state | presets per class (R1–R3: `main` / `subagent`, as in the §10 Magic Context table). The sub-agent sniffing goes away (R2) | Covered |
| Turn, iteration and context-limit nudges | turn-scoped reminders (§7.5) | Covered |
| `compress` permission `ask` | §12 "Asking the user" | Covered with work |
| `experimental.text.complete` (clean assistant text before persistence) | no class covers assistant-output rewrite. As reduction owner DCP could hide the tags in its own view, but not in the stored text | Gap (b), low priority, G10 |
| `/dcp` stats, sweep, decompress (user-driven reducer control) | commands (§11, §12) | (c) |
| Auto-update | outside the session design | (c) |

**Verdict: Covered with work.** The reducer, tool, text and nudges fit. The gaps are small: G10, and Q3 on third-party reducers.

### OC-6 `opencode-models-discovery`

**Surfaces:**
- `config` (`src/plugin/config-hook.ts:31`) queries `/v1/models` on configured OpenAI-compatible providers and writes the models into provider config;
- `event` (`src/plugin/event-hook.ts:11`) shows toasts;
- OpenCode 2 tools `models_discovery_refresh` and `models_discovery_status` (`src/v2/tools.ts:28-39`).

State: persisted model store (`src/plugin/provider-model-store.ts`). Net: yes. UI: toasts.

**Mapping.** Provider and model catalogs are out of scope (§11, "subc modules today (claustrum, broca providers)"). The two status tools could be preset tools.

**Verdict: Gap (c).**

### OC-7 `@plannotator/opencode`

**Surfaces** (`apps/opencode-plugin/index.ts`):
- `config` (`:326`, workflow agents and commands);
- `experimental.chat.messages.transform` (`:333`) **rewrites OpenCode's built-in plan-mode reminder text in the user message** to allow markdown writes;
- `tool.definition` (`:373`) overrides the descriptions of the built-in `plan_exit` and `todowrite`;
- `experimental.chat.system.transform` (`:387`), which reads session messages through the client to find the agent;
- `command.execute.before` (`:464`);
- a `submit_plan` tool that opens a browser review served locally (`server.ts`) and waits for the user's decision.

State: yes. Net: local HTTP server. UI: browser. Cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Planning guidance | static preset text (§6.3) | Covered |
| Rewriting the host's plan-mode text in history | editing another party's text: forbidden by principle 1, R5 and protected spans (§7.7) | (a) |
| Overriding built-in tool descriptions | principle 1. The sanctioned path is `replaces_slots` for `plan_exit`/`todowrite` (§6.2) | (a), with an alternative |
| `submit_plan` blocking on a user decision in a browser | tool plus §12 "Asking the user", plus an R8 host capability (a UI able to confirm) | Covered with work |
| Plan mode as an agent the user switches to | a different preset or persona mid-session (G1) | Gap (b) |

**Verdict: Gap** (G1). Everything else is Covered, Covered with work, or (a) with a sanctioned alternative.

### OC-8 `opencode-antigravity-auth`

**Surfaces** (`src/plugin.ts`):
- `event` (`:1384`);
- tool `google_search` (`:1385`);
- `auth` with `loader` (`:1388-1390`) returning a custom `fetch` (`:1454`) that rewrites Gemini payloads. It also prepends `ANTIGRAVITY_SYSTEM_INSTRUCTION` to the system instruction on the wire (`src/plugin/request.ts:1476-1478`, `src/constants.ts:254`).

Net: yes. State: account store.

**Mapping.** Auth and provider transport are (c) (§11). `google_search` is a preset tool (Covered). The wire-level system text is a provider concern, invisible to composition. In CK it would sit in the Broca provider module, outside the composition record's digest (§7.2 step 4). That's worth one line in §11 so provider modules aren't read as a back door for operator text (Q7).

**Verdict: Gap (c).**

### OC-9 `opencode-gemini-auth`

**Surfaces** (`src/plugin.ts`):
- `config` (`:66`, a quota command);
- `tool` (`:74`, a quota tool);
- `auth` loader and methods (`:82-175`);
- OpenCode 2 variant `src/plugin-v2.ts`.

Net: yes.

**Mapping.** Same as OC-8: auth (c), quota tool Covered.

**Verdict: Gap (c).**

### OC-10 `opencode-mem`

**Surfaces** (`src/index.ts`):
- `config` (`:451`);
- `chat.message` (`:455`): searches memories and **prepends a synthetic text part** with recalled context to the user message (`:539-546`), so it's persisted;
- `chat.params` (`:565`) captures the active model so its own LLM calls can inherit it;
- a `memory` tool with add/search/profile/list/forget/export/import modes (`:579`);
- `event` (`:938`): `session.idle` triggers automatic capture through an LLM call, and `session.compacted` is handled too.

State: local vector store with embeddings (`src/services/embedding.js`). Net: an LLM provider for capture. UI: web server (`src/services/web-server.ts`).

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| `memory` tool | preset tool | Covered |
| Automatic recall into the user turn every prompt | class 2 request decoration, with open authority and persistence (G2) | Covered with work |
| Automatic capture on idle and compaction | class 5 observe. Needs message content in the stream (Q5) | Covered with work |
| Using the session's model for its own LLM calls | a module calling a model is module business. Knowing the session's model is route context (plugin-hooks "Route-decision snapshot is CONTEXT"), which the CK design doesn't expose to modules | Covered with work (Q6) |
| Web UI | (c) | (c) |

**Verdict: Covered with work** (G2). Recall is the plugin's core, so G2 decides whether it's writable.

### PI-1 `pi-subagents`

**Surfaces:**
- `src/extension/index.ts`:
  - `registerTool` (`subagent`, wait, status);
  - `before_agent_start` (`:860`) appends an **advertised agent list built at runtime** from agent files to `systemPrompt`;
  - `tool_result` (`:947`);
  - `agent_start`, `agent_settled`, `agent_end`;
  - `session_before_compact` and `session_compact`;
  - `session_start` and `session_shutdown`;
- `sendMessage` for async completion and steering notices (`src/extension/control-notices.ts`, `steering-notices.ts`);
- a loader tool `subagents_enable` that reveals tools with `setActiveTools` at runtime (`src/extension/tool-activation.ts`);
- child Pi processes (`src/runs/shared/external-cli-runner.ts`);
- a child-only `before_provider_request` fast-mode rewrite (`src/runs/shared/fast-mode-extension.ts`);
- `registerCommand` ×6 (`src/slash/slash-commands.ts`, `prompt-workflows.ts`);
- `appendEntry` watchdog records (`src/watchdog/register-child.ts`);
- the herdr bridge (`src/extension/herdr-pi-bridge.ts`).

State, proc and UI: yes. Cmd: yes. Survey §7 lists the main surfaces.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| `subagent` and related tools; child agents run in the module's own processes | module tools (§4). A module may spawn processes; third-party modules are in the restricted tier (§8) | Covered |
| Async completions and steering | `provider_notice` (§7.4) | Covered with work (G4: does a notice wake an idle session?) |
| Advertised agent list built at runtime, in the system prompt | per-session value, so the untrusted carrier (§6.3) | Covered (authority drops to user, which is correct) |
| Loader tool that reveals tools on demand | §12 "Deferred tools … not in v1". The design only avoids blocking them | Covered with work |
| Fast-mode payload rewrite in children | provider request shaping (c). Also the children are Pi, not CK sessions | (c) |
| Commands, widgets | (c) | (c) |

**Verdict: Covered with work** (§12 deferred tools, G4).

### PI-2 `context-mode`

**Surfaces:**
- `src/adapters/pi/extension.ts`:
  - `session_start` (`:467`);
  - `tool_call` (`:483`) blocks `bash` commands that match HTTP-client regexes or unsafe `curl`/`wget`;
  - `tool_result` (`:532`) records events to a SQLite session store;
  - `before_agent_start` (`:607`) records the user prompt and builds routing guidance, an `<active_memory>` block from recent high-priority events, and a one-shot resume snapshot left from the last compaction;
  - `context` (`:740`) **pushes that text as a user message into the per-call view** (ephemeral, not persisted);
  - `before_provider_response` (`:760`), `turn_end` (`:809`);
  - `session_before_compact` (`:827`) writes the resume snapshot, `session_compact` (`:847`);
  - `registerCommand` `ctx-stats` and `ctx-doctor` (`:898`, `:911`);
- MCP bridge (`src/adapters/pi/mcp-bridge.ts`): spawns the MCP server (`:498`) and registers its tools (`:1023`).

State: SQLite. Proc: yes. Cmd: yes. Survey §7 covers its Claude Code and OpenCode surfaces.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| `ctx_execute`, `ctx_search`, fetch-and-index tools | tools from a running module (§4, §5.2) | Covered |
| Routing guidance ("Hierarchy: ctx_batch_execute > …") | static preset text naming the module's own tools; R7 closure applies | Covered |
| Blocking `curl`/`wget`/HTTP clients in `bash` | class 3 declarative deny. The regex over `command` works if the rule vocabulary allows argument regexes (Q4). `isSafeCurlWget` segment analysis is computed | Covered with work / (a) for the computed part |
| Event capture from tool results and prompts | class 5 observe (Q5) | Covered with work |
| Active memory and resume snapshot as a user-role block at the start of each run | G2 (class 2 at admission, user authority, persistence) and G6 (placement after a compaction) | Covered with work |

**Verdict: Covered with work.**

### PI-3 `pi-mcp-adapter`

**Surfaces** (`index.ts` unless noted):
- a single proxy tool `mcp` plus optional direct tools (`:404`; `namespace-tools.ts:245`, with `unregisterTool` at `:282-287`);
- `setActiveTools` for lazy tool activation (`:449-562`, `:2007`);
- MCP prompts as commands (`:716`), `registerFlag` (`:841`);
- `resources_discover` (`:1056`), `session_start` (`:1070`);
- `before_agent_start` keeps lazy tools inactive (`:1151`);
- `input` (`:1169`), `tool_result` error override (`:1219`);
- `mcp-auth` OAuth command (`:1450`);
- consent and approval (`consent-manager.ts`, `tool-approval.ts`, `session-approvals.ts:127` `appendEntry`);
- MCP elicitation and sampling (`elicitation-handler.ts`, `sampling-handler.ts`);
- MCP UI apps in a Glimpse window (`glimpse-ui.ts`, `ui-session.ts`, with `sendMessage` results).

State, proc, net, UI and cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| MCP servers as tool sources | declarative MCP tool sources (§5.3) or a running module (§5.2) | Covered |
| One `mcp` proxy tool (search, describe, call) | a plain preset tool | Covered |
| Lazy activation of direct tools | §12 deferred tools | Covered with work |
| Per-server and per-tool consent prompts | §12 "Asking the user" | Covered with work |
| MCP elicitation (the server asks the user) and sampling (the server asks the host's model) | ask-user (§12). There's no host model call for modules, but a module can call a model itself | Covered with work / (c) |
| MCP OAuth | auth (c) | (c) |
| MCP UI apps, commands, flags | (c) | (c) |

**Verdict: Covered with work** (§12 items).

### PI-4 `@plannotator/pi-extension`

**Surfaces** (`apps/pi-extension/index.ts`):
- `session_start` (`:347`, `:1822`), `session_shutdown` (`:352`);
- `registerFlag("plan")` (`:364`);
- `registerCommand` ×4 (`:663-1071`), `registerShortcut` (`:1165`);
- `registerTool` for mark-step-done and submit-plan (`:1174`, `:1215`);
- `setActiveTools` per phase (`:529`, `:562`, `:1812`);
- `tool_call` (`:1467`) blocks `write`/`edit` outside `.md`/`.mdx` inside cwd while planning;
- `before_agent_start` (`:1487`) delivers phase framing as a conversation append. The comment says it never modifies `systemPrompt`, to protect the cache;
- `turn_end` (`:1631`) parses assistant text to tick checklist items;
- `agent_end` (`:1646`) auto-continues after approval with `sendUserMessage`;
- `session_compact` (`:1859`), `session_tree` (`:1869`);
- a local HTTP server (`server.ts`) and browser (`plannotator-browser.ts:204`).

State, net (local), UI and cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Phases idle → planning → executing, each with its own tool set and framing, switched by a tool result (plan approved) or a command | a module-initiated preset change mid-session. The design has no such request (§6.5: prefrontal decides; R1: variants are presets picked by the table) | **Gap (b)**, G1 |
| Phase framing as a conversation append | persistent `operator_message` (§7.4), which is precedence-safe when this module is last in order (§6.4) | Covered |
| Markdown-only writes while planning | class 3 deny with a path rule: "extension not in {md, mdx} or outside cwd". It also depends on the phase, so it's either a per-preset rule set (good under G1) or state-dependent code (a) | Covered with work (Q4) |
| Submit plan and wait for the browser decision | §12 ask-user plus an R8 UI capability | Covered with work |
| Checklist ticking from assistant text | class 5 observe | Covered with work (Q5) |
| Auto-continue after approval | G4 | Gap (b) |
| Commands, shortcut, flag, browser | (c) | (c) |

**Verdict: Gap** (G1, G4).

### PI-5 `pi-web-access`

**Surfaces** (`index.ts`):
- `registerTool` ×4: web search, source check, fetch content, get search content (`:1832`, `:2433`, `:2532`, `:2889`);
- background fetch results via `sendMessage({customType, content, display:true}, {triggerTurn:true})` (`:1131`, `:1145`);
- `appendEntry` stores results in the session (`:644`, `:1124`, `:1165`);
- `registerShortcut` ×2 (`:1786`, `:1801`), `setWidget` (`:1016`);
- `registerCommand` ×4 (`:3275-3629`);
- `session_start`, `session_tree`, `session_shutdown` (`:1816-1819`);
- a browser "curator" (local server).

State, net, UI and cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| The four tools | preset tools. The web-search reply naming `get_search_content` is an R7 declared reference | Covered |
| Background fetch completion that also starts a turn | `provider_notice` (§7.4). "Appended … immediately if the session is idle" says nothing about starting a run (G4) | Covered with work |
| Results stored in the session | module-owned state keyed on the session. Behaviour across a fork or branch is unspecified (Q8) | Covered |
| Curator UI, widgets, shortcuts, commands | (c) | (c) |

**Verdict: Covered with work** (G4).

### PI-6 `@ff-labs/pi-fff`

**Surfaces** (`packages/pi-fff/src/index.ts`):
- `registerTool` (`:679`) for the fff grep and find tools, or under the names `grep`/`find` in `override` mode (`:75-81`);
- `setActiveTools` prunes stale names (`:715`);
- `registerFlag` ×7 (`:726-759`);
- `ctx.ui.addAutocompleteProvider` for `@`-mentions (`:616`), `setStatus`;
- `session_start` (`:812`), `before_agent_start` (`:848`, lazy init), `session_shutdown`;
- `registerCommand` `fff-mode`, `fff-health`, `fff-rescan` (`:1405-1484`);
- the mode is persisted with `appendEntry` (`:1435`);
- native Rust core through `@ff-labs/fff-node`/`-bun`.

State: frecency database. UI and cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| fff tools alongside the built-ins (`tools-only` mode) | a preset with tools | Covered |
| `override` mode replacing `grep` and `find` | a preset with `replaces_slots: [grep, glob/find]` (§6.2 exclusive slots, the §10 AFT edit presets) | Covered |
| Mode chosen per project | a composition-table override per project (§6.1) | Covered |
| `/fff-mode` switch mid-session | G1 | Gap (b), minor |
| `@`-mention autocomplete, status, flags | (c) | (c) |

**Verdict: Covered** (G1 for the in-session switch only).

### PI-7 `@juicesharp/rpiv-ask-user-question`

**Surfaces** (`packages/rpiv-ask-user-question/`):
- `registerTool("ask_user_question")` (`ask-user-question.ts:305`), which renders a tabbed questionnaire with `ctx.ui.custom` (`:372`) and raw terminal input (`:160`);
- `before_agent_start` reconciler (`reconcile.ts:25-46`) removes the tool from the active set when `!ctx.hasUI` and restores it otherwise;
- an RPC fallback (`rpc-fallback.ts`).

UI: yes. Survey §7 lists `rpiv-mono` as a whole.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| A tool that blocks on a structured user answer | §12 "Asking the user" (a first-class host call, not yet in the contract) | Covered with work |
| Tool present only when a UI exists | R8: the host declares capabilities, the preset states the requirement, and admission refuses or takes the fallback preset the table names | Covered |
| TUI rendering of the questionnaire | the host renders; the design doesn't define a question schema | Covered with work (part of the §12 item) |

**Verdict: Covered with work** (§12 ask-user).

### PI-8 `gentle-engram`

**Surfaces** (`plugin/pi/index.ts`):
- spawns `engram serve` (`:820`) and talks to it over HTTP (`:311` and the helpers at `:1553-1719`);
- `registerTool` for memory search, save, timeline and so on (`:1775`);
- `session_start` (`:1797`), `session_shutdown` (`:1812`);
- `session_compact` (`:1861`) archives the compaction summary and prepares a **recovery notice with recalled context**;
- `before_agent_start` (`:1900`) appends static `MEMORY_INSTRUCTIONS` **and that recovery notice to `systemPrompt`**, and posts the user prompt to the server;
- `tool_execution_end` (`:1935`) captures observations;
- `appendEntry` for session identity (`:1087-1115`).

State, proc and net: yes. No UI, no cmd.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Memory tools served by a local server the module runs | module tools (§4, §5.2) | Covered |
| Static memory instructions | preset system text with a grant (§6.3) | Covered |
| Recalled context appended to the system prompt | forbidden: recalled content must never be operator authority (§7.3, §7.7, §8). It must move to a user-role carrier | (a) |
| Recovery notice after compaction | `provider_notice` placed after the reduction boundary. Needs compaction as an observable event (G6) | Covered with work |
| Prompt and tool observation for capture | class 5 observe (Q5) | Covered with work |

**Verdict: Covered with work.** The one (a) item has a compliant replacement.

### PI-9 `@juicesharp/rpiv-todo`

**Surfaces:**
- `packages/rpiv-todo/todo.ts`: `registerTool("todo")` (`:69`) with a state machine, guidance strings in the description (`:60-66`), and a `todos` command (`:107`);
- `index.ts`: `registerShortcut` (`:163`); `session_start`, `session_compact`, `session_tree` and `session_shutdown` rebuild state from the session branch (`:194-227`); `tool_execution_end` (`:264`), `agent_start` (`:287`);
- a live overlay widget.

State: in tool-result details. UI and cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| `todo` tool and its guidance | preset tool. The description is static | Covered |
| State per session branch, rebuilt on tree navigation or compaction | module state keyed on the session. Fork and branch semantics aren't specified (Q8) | Covered, with Q8 |
| Overlay, shortcut, command | (c) | (c) |

**Verdict: Covered** (UI (c)).

### PI-10 `billion-context`

**Surfaces:**
- `src/agent/pi-native.ts` spawns a local proxy and patches `globalThis.fetch` so model-API requests go through it (`src/agent/native-intercept.ts`);
- `src/agent/pi.ts`:
  - registers tools from the proxy's manifest (`:280`);
  - `registerProvider` (`:356`);
  - `session_before_compact` returns `{cancel:true}` when it owns compaction (`:423-441`);
  - `registerCommand` `acp`, `acp-cache`, `acp-rule` (`:478-585`);
  - `before_provider_headers` (`:633`) and `before_provider_request` (`:704`) claim the session and register identity;
  - `session_start`, `session_switch`, `session_compact` (`:474-475`, `:727-735`).

State, proc and net: yes. Cmd: yes.

**Mapping**

| Capability | CK mechanism | Status |
|---|---|---|
| Model-driven context compression | reduction owner (§6.6). The composition table picks it instead of host compaction, so "cancel host compaction" becomes a table choice | Covered with work: Q3 (can a third party be the reduction owner, and what's its transform interface?) |
| Compression tools from the proxy manifest | preset tools | Covered |
| Patching `fetch` and rewriting wire requests after the host | outside any contribution kind. A transport interposer rewrites bytes after the composition digest (§7.2 step 4) and after protected-span checks (§7.7) | (a) |
| `registerProvider`, headers | (c) | (c) |
| Commands | (c) | (c) |

**Verdict: Covered with work**, if it's rewritten as a transform; its current proxy architecture is (a).

## 4. Summary table

| Host | # | Plugin | Verdict | Gaps (see §5) |
|---|---|---|---|---|
| OC | 1 | ponytail | Covered with work | G1, G9; commands (c) |
| OC | 2 | oh-my-openagent | Gap | G1, G4, G5 (a), G6, G7, G8; routing (c) |
| OC | 3 | oh-my-opencode-slim | Gap | G1, G4, G5 (a), G7, G8; routing (c) |
| OC | 4 | @openviking/opencode-plugin | Covered with work | G2, Q4, Q5 |
| OC | 5 | @tarquinen/opencode-dcp | Covered with work | Q3, G10, §12 ask-user; commands (c) |
| OC | 6 | opencode-models-discovery | Gap (c) | providers |
| OC | 7 | @plannotator/opencode | Gap | G1; §12 ask-user; host-text rewrite (a) |
| OC | 8 | opencode-antigravity-auth | Gap (c) | auth and transport; Q7 |
| OC | 9 | opencode-gemini-auth | Gap (c) | auth |
| OC | 10 | opencode-mem | Covered with work | G2, Q5, Q6; web UI (c) |
| Pi | 1 | pi-subagents | Covered with work | G4, §12 deferred tools |
| Pi | 2 | context-mode | Covered with work | G2, G6, Q4, Q5 |
| Pi | 3 | pi-mcp-adapter | Covered with work | §12 ask-user, §12 deferred tools; OAuth and UI (c) |
| Pi | 4 | @plannotator/pi-extension | Gap | G1, G4; §12 ask-user |
| Pi | 5 | pi-web-access | Covered with work | G4; curator UI (c) |
| Pi | 6 | @ff-labs/pi-fff | Covered | G1 (minor); autocomplete (c) |
| Pi | 7 | rpiv-ask-user-question | Covered with work | §12 ask-user |
| Pi | 8 | gentle-engram | Covered with work | G6, Q5; system-prompt recall (a) |
| Pi | 9 | rpiv-todo | Covered | Q8; UI (c) |
| Pi | 10 | billion-context | Covered with work | Q3; fetch interposer (a) |

Counts: Covered 2, Covered with work 11, Gap 7. Of the 7 Gaps, 3 are (c) (auth and providers) and 4 are (b) (G1 in all four, G4 in three, G7 and G8 in two).

18 of the 20 use commands, UI, flags, toasts or shortcuts (the exceptions are `@openviking/opencode-plugin` and `gentle-engram`). §11 already names these as the most common out-of-scope surface.

## 5. Gaps grouped by the design section they would change

### §6.1 / §6.5: composition and activation

- **G1. Switching preset mid-session on request (b).** It appears in ponytail (`/ponytail`, "stop ponytail"), plannotator on both hosts (planning → executing on approval), fff (`/fff-mode`), omo (keyword modes), slim (`preset-switch`). Six of the 20 turn behaviour bundles on and off inside a session. The design picks presets once from the table (§6.1). Activation happens only when prefrontal decides, at a run boundary (§6.5). Neither the user nor the module has a way to ask.

  **Smallest addition:** let a table row name, per module, a set of *alternate presets* allowed for that class. Add a "switch to preset X" request that a user command or the module itself (in a tool reply) can raise. Prefrontal validates it against the row, and it activates at the next run boundary through the existing §6.5 and §7.5 machinery (ordered rebuild or `operator_message`). This keeps R1 (no parameters) and R3 (only the table grants presets), and adds no new delivery path.

- **G7. Modules shipping personas or agents (b).** omo and slim ship agent rosters. A persona is prefrontal's, and §5.3 declarative files carry "system text, MCP tool sources, replaced slots" only.

  **Smallest addition:** allow a declarative extension to carry a persona (role text plus the class it runs as), installed and pinned like any other file (§5.3). The table can then name it. Tools still come only from presets.

### §6.6 / §7.7: history operations

- **Q3 (a question, blocks DCP and billion-context).** Can a third-party module be the reduction owner, and what's the transform interface it must serve? §6.6 says v1 ships "the reducer only", and every reference is to Magic Context's transform (`run.rs:2050` replay, `tool_present`). Two of the 20 are reducers.
- **G6. Contributing to or after a reduction you don't own (b).** omo (compaction-context-injector, todo-preserver), context-mode (resume snapshot), engram (recovery notice) and OpenViking (flush on compaction) all react to compaction. A single owner is correct (a). But the design gives no observable "reduction happened" event and no rule for placing a notice right after the reduction boundary.

  **Smallest addition:** add the reduction boundary to the class 5 observe stream, and state that a `provider_notice` sent in response is placed after the boundary.
- **G8. Rewriting the current user turn (b, low).** slim swaps images for a text nudge when the model has no vision, and omo detects keywords. The pipeline stage in §6.6 must preserve every sent span, and nothing covers editing the *incoming* turn before it's first sent.

  **Smallest addition:** a write-time input stage (like plugin-hooks class 4, "decorate once and persist") applied to the user turn before it's first written. That's cache-safe by construction.
- **G10. Assistant-output cleanup before persistence (b, low).** DCP's `experimental.text.complete`. No class covers it. It could be the same write-time class, applied to assistant text.

### §7.4 / §7.5: records and delivery

- **G2. Per-run context at user authority (b).** OpenViking, opencode-mem and context-mode inject recalled memory or event context with each prompt, and engram did the same until compaction. The only matching seam is class 2 request decoration. The design mentions it only as the reminder fallback ("class 2 tail decoration, never persisted", §7.5), and §8 gives it no authority row. If it's never persisted, recall vanishes after one run: every later request rebuilds it or loses it.

  **Smallest addition:** define a per-run *context contribution*. The module returns it at admission, it's written once into the WAL as a user-role block (the same shape as `provider_notice`, placed right after the user turn), and it carries untrusted authority. Add the §8 row.
- **G4. Starting a run and continuing (b).** omo (todo continuation, ralph loop), slim (orchestrator wake), plannotator Pi (`agent_end` continue), pi-web-access (`triggerTurn:true`) and pi-subagents all need to wake an idle session. §7.4 says a notice is "appended … immediately if the session is idle" but doesn't say whether that starts a run.

  **Smallest addition:** a `wake` field on `provider_notice`, whose effect is a class-profile decision in prefrontal (for example, heads may be woken and workers only between tasks), recorded in the WAL. A stop hook that returns "continue" is the same thing with a different trigger. Survey §8 lists it as a common request.

### §7 hook classes (plugin-hooks classes 3 and 4)

- **Q4. The declarative rule vocabulary isn't specified.** OpenViking (URI prefix), context-mode (regex over `bash.command`), plannotator (path extension plus inside cwd, depending on phase) and cc-safety-net (a Pi runner-up, §1.3) need argument regexes, path globs relative to the working directory, and rule sets scoped per preset. These are what decide whether they're Covered or (a).
- **G5. Computed per-call interception and decoration (a).** Checking that a path exists, loop detection, running a binary after an edit, and injecting files keyed on the path just read all need code on the step path, which §7.8 and plugin-hooks rule out ("No arbitrary computed class-3 rewrites in v1"; WASM deferred). This is a deliberate exclusion. The design should state the sanctioned workaround in §6.2: own the tool slot (`replaces_slots`) and do the work inside the tool. That covers most of these cases (omo's hashline edit, comment checker and rules injection all attach to tools omo already replaces).

### §5.3: declarative extensions

- **G9. Skills (b).** ponytail, omo and superpowers ship skills: a catalog in the prompt and bodies read on demand. §5.3 can carry the catalog as static text, but not the bodies.

  **Smallest addition:** let a declarative file carry named text resources, served through one host read path, with the catalog as ordinary static system text.

### §11 / §12: scope and open items

- **§12 "Asking the user" is needed by 5 of the 20:** rpiv-ask-user-question, plannotator on both hosts, pi-mcp-adapter (consent, elicitation) and DCP (permission `ask`), plus slim's `wait-for-user`. This is the most-used capability the design leaves open.
- **§12 deferred tools:** pi-subagents and pi-mcp-adapter depend on revealing tools at runtime.
- **§11 commands and UI:** 18 of 20. Out of scope (c) is defensible for v1. The data suggests commands matter mainly as *triggers* (switch mode, decompress, submit), which G1 and G4 would cover without a UI contribution kind.
- **§11 providers, models and auth:** 3 of the 10 OpenCode plugins are only this (c). omo, slim and opencode-mem also touch model parameters (Q6).

## 6. Top three recommendations for r3

1. **Add G1, a preset switch on request, activated at the next run boundary.** It's the most common Gap (6 of 20, including both plannotator packages and both "oh-my" harnesses). It fits inside the machinery that already exists: table alternates, §6.5 activation, and §7.5 delivery. Resolve Q1 at the same time.
2. **Settle §12 "Asking the user" and G4, starting a run and continuing, as host services with WAL records.** Together they account for most of the remaining "Covered with work" and "Gap" verdicts: ask-user in 5 plugins, wake or continue in 5.
3. **Specify per-run user-authority context (G2) and the class 3 rule vocabulary (Q4).** Memory plugins are the largest single category in both lists (OpenViking, opencode-mem, engram, context-mode). Without G2 they either misuse operator text (engram today) or disappear from history after one run. Q4 decides whether guard plugins are declarative data or excluded code.

## 7. Ambiguities found while mapping (questions, not interpretations)

- **Q1.** §6.5 says "Prefrontal decides when a session activates". plugin-hooks ("Class-1 epoch activation") says "activation IS the module flipping its declared epoch for a session". Which one governs? Can a module change its contribution for one session only, or only for all sessions through a new `extension.describe` reply?
- **Q2.** §6.4 lets only the *last* module in table order append a changed contribution without a rebuild. Is the table order chosen with that in mind, for example by placing the modules whose text changes most often last? Or is every switch from any other module expected to cost an ordered rebuild?
- **Q3.** Can a third-party module be the reduction owner, and which transform interface does it serve (request and response shape, replay key)? (§6.6, §7.7)
- **Q4.** What is the class 3 declarative vocabulary: argument regex, path globs relative to cwd, deny with a custom reason, rewrite templates? Can a rule set belong to a preset, so it changes with G1?
- **Q5.** Does the class 5 observe stream carry message content (user prompt text, tool arguments and results) and reduction or compaction events? Is it available to third-party modules in the restricted tier (§8)?
- **Q6.** May a preset declare generation parameters (reasoning effort, temperature), or are those persona and route only? May a module read the session's resolved model (the route snapshot) at admission?
- **Q7.** Provider modules (Broca providers, claustrum) can rewrite system text on the wire, as `opencode-antigravity-auth` does. Is that inside the composition record's digest (§7.2 step 4) and the trust rules of §8, or explicitly outside the session-extension design?
- **Q8.** When a session forks or a lineage branches, what does a module receive so it can keep per-branch state (rpiv-todo, ponytail and fff rebuild state from Pi's branch entries on `session_tree`)?
- **Q9.** Does the "no module code on the step path" rule (§7.8) forbid a module from computing a `provider_notice` in reaction to an observed tool result (for example, a reminder after the third identical read)? Notices are data, but the reaction is code running mid-run.
- **Q10.** R7 requires every tool to declare `references`. Do references cover *host* built-ins named in a module's guidance (context-mode's text names `bash`), and does a reference into a slot another preset replaces resolve to the replacement?

## 8. Limits of this report

- Host surfaces come from each repo's default branch at the commit listed. For `oh-my-openagent`, HEAD is 5.0.0-beta.90, while npm `latest` is 4.19.4. Survey §7 records the same hook set for the 1.x line.
- Line numbers point into the files as read. Minified or bundled npm output wasn't compared with source.
- "Stars" are repository stars. Umbrella repos are flagged in §1.
- Download counts include CI and mirror traffic. The two exclusions for missing star signals (§1.4) are judgement calls, and the numbers are recorded so the ranking can be recomputed.
