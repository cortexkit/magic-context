// Fixture-only visual gate for the light and dark themes. No native backend,
// database or operator config is contacted: every IPC command is answered from
// the fixtures below. Captures every page in both themes at each width, checks
// that the theme is applied before <body> is parsed (no flash), that System
// follows an OS appearance switch live, that the picker persists, and audits
// the rendered text contrast of every captured light-theme screen.
// Run: timeout 600s bun packages/dashboard/scripts/theme-browser.ts "$TMPDIR/magic-context/<task>/screens"
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Screenshot directory required");
mkdirSync(root, { recursive: true });
const dashboard = resolve(import.meta.dir, "..");
const widths = (process.env.THEME_BROWSER_WIDTHS ?? "1280,900").split(",").map(Number);
const HEIGHT = 820;
const PORT = 1429;

const NOW = Date.UTC(2026, 4, 14, 15, 30);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const P1 = "git:4f1c2a9e";
const P2 = "git:9a0b7d31";
const P3 = "dir:73e1b0aa";
const projectCards = [
  { identity: P1, display_name: "magic-context", primary_path: "/Users/dev/Work/magic-context", harnesses: ["opencode", "pi", "claude_code"], session_count: 148, memory_count: 212, workspace_name: "CortexKit", last_activity_ms: NOW - 4 * MIN },
  { identity: P2, display_name: "agent-file-tools", primary_path: "/Users/dev/Work/aft", harnesses: ["opencode", "codex"], session_count: 61, memory_count: 87, workspace_name: "CortexKit", last_activity_ms: NOW - 3 * HOUR },
  { identity: P3, display_name: "marketing-site", primary_path: "/Users/dev/Work/site", harnesses: ["claude_code"], session_count: 9, memory_count: 14, workspace_name: null, last_activity_ms: NOW - 6 * DAY },
];
const projects = projectCards.map((p) => ({ identity: p.identity, label: p.display_name, path: p.primary_path }));
const memoryProjects = projectCards.map((p) => ({ identity: p.identity, display_name: p.display_name, primary_path: p.primary_path, harnesses: p.harnesses, session_count: p.session_count }));

const SID = "ses_7f3a91c0d2e84b5fa1c3";
const sessionRows = [
  { harness: "opencode", session_id: SID, title: "Light theme for the dashboard", project_identity: P1, project_display: "magic-context", last_activity_ms: NOW - 4 * MIN, is_subagent: false },
  { harness: "pi", session_id: "pi_2b77e019", title: "Historian fallback chain refactor", project_identity: P1, project_display: "magic-context", last_activity_ms: NOW - 2 * HOUR, is_subagent: false },
  { harness: "claude_code", session_id: "cc_51d0aa", title: "Investigate cache bust after compaction", project_identity: P1, project_display: "magic-context", last_activity_ms: NOW - 5 * HOUR, is_subagent: false },
  { harness: "opencode", session_id: "ses_sub_0193", title: "explore: find dreamer schedule callers", project_identity: P1, project_display: "magic-context", last_activity_ms: NOW - 5 * HOUR, is_subagent: true },
  { harness: "codex", session_id: "codex_88ad", title: "", project_identity: P1, project_display: "magic-context", last_activity_ms: NOW - 2 * DAY, is_subagent: false },
];

const compartments = [
  { id: 1, sequence: 1, start_message: 1, end_message: 42, title: "Surveyed dashboard styling and token usage", importance: 45, episode_type: "research", legacy: 0, p1: "Read styles.css and config-editor.css. Most colours already flow through CSS custom properties; a few rgba() tints, shadows and an SVG chevron were hard-coded.", p2: "Surveyed styling; most colours tokenised, some rgba/shadows hard-coded.", p3: "Styling survey.", p4: "survey" },
  { id: 2, sequence: 2, start_message: 43, end_message: 120, title: "Designed light palette with WCAG AA targets", importance: 82, episode_type: "design,decision", legacy: 0, p1: "Chose cool-grey neutrals (#f4f5f7 base, white cards) and darkened status colours so pill text on a 15% tint stays above 4.5:1. Chart fills use separate brighter tokens.", p2: "Light palette designed for AA.", p3: "Palette.", p4: "palette" },
  { id: 3, sequence: 3, start_message: 121, end_message: 160, title: "Pre-paint theme boot script", importance: 68, episode_type: "implementation", legacy: 0, p1: "Serve mode only serves /assets/* and the CSP forbids inline scripts, so the boot script ships from public/assets.", p2: "Boot script from /assets.", p3: "Boot.", p4: "boot" },
  { id: 4, sequence: 4, start_message: 161, end_message: 210, title: "Fixture browser harness and screenshots", importance: 30, episode_type: "verification", legacy: 0, p1: "Headless Chrome against Vite with a mocked Tauri IPC.", p2: "Fixture harness.", p3: "Harness.", p4: "harness" },
  { id: 5, sequence: 5, start_message: 211, end_message: 236, title: "Legacy summary of earlier exploration", importance: 12, legacy: 1, content: "Earlier exploration of the dashboard layout (legacy compartment, no tiers)." },
].map((c) => ({ session_id: SID, created_at: NOW - 3 * HOUR + c.id * 10 * MIN, start_time: NOW - 4 * HOUR + c.id * 10 * MIN, end_time: NOW - 4 * HOUR + c.id * 12 * MIN, content: c.p1 ?? "", ...c }));
const facts = [
  { id: 11, category: "ARCHITECTURE_DECISIONS", content: "Theme colours live in CSS custom properties on :root[data-theme]." },
  { id: 12, category: "ARCHITECTURE_DECISIONS", content: "public/assets/theme-boot.js runs before the bundle to avoid a flash." },
  { id: 13, category: "CONSTRAINTS", content: "CSP is script-src 'self'; no inline scripts in index.html." },
  { id: 14, category: "WORKFLOW_RULES", content: "Run bun run test, typecheck and lint in packages/dashboard before committing." },
].map((f) => ({ session_id: SID, created_at: NOW - 2 * HOUR, updated_at: NOW - HOUR, ...f }));
const notes = [
  { id: 21, type: "session", status: "active", content: "Check the config help popover shadow in light mode.", session_id: SID, project_path: null, surface_condition: null, created_at: NOW - 90 * MIN, updated_at: NOW - 90 * MIN, last_checked_at: null, ready_at: null, ready_reason: null },
  { id: 22, type: "session", status: "active", content: "Dark theme muted text is below AA; report, don't change.", session_id: SID, project_path: null, surface_condition: null, created_at: NOW - 60 * MIN, updated_at: NOW - 60 * MIN, last_checked_at: null, ready_at: null, ready_reason: null },
];
const smartNotes = [
  { id: 31, type: "smart", status: "ready", content: "Release notes should mention the new theme picker.", session_id: null, project_path: P1, surface_condition: "When the next release branch is cut", created_at: NOW - 3 * DAY, updated_at: NOW - DAY, last_checked_at: NOW - HOUR, ready_at: NOW - HOUR, ready_reason: "release/0.20 branch created" },
  { id: 32, type: "smart", status: "pending", content: "Revisit dark-theme muted text contrast.", session_id: null, project_path: P1, surface_condition: "When the dashboard design is revisited", created_at: NOW - 2 * DAY, updated_at: NOW - 2 * DAY, last_checked_at: NOW - 2 * HOUR, ready_at: null, ready_reason: null },
];
const meta = { session_id: SID, last_response_time: NOW - 4 * MIN, cache_ttl: "5m", counter: 236, last_nudge_tokens: 118_000, last_nudge_band: "medium", is_subagent: false, last_context_percentage: 61.4, last_input_tokens: 122_840, compartment_in_progress: false, system_prompt_hash: "9c0e4f7a1b2d3c4e5f60718293a4b5c6", memory_block_count: 3, new_work_tokens: 18_400, total_input_tokens: 4_812_330 };
const tokenBreakdown = { total_input_tokens: 122_840, system_prompt_tokens: 14_200, compartment_tokens: 21_900, fact_tokens: 3_100, memory_tokens: 9_800, conversation_tokens: 73_840, compartment_count: 5, fact_count: 4, memory_count: 38 };
const sessionDetail = { harness: "opencode", session_id: SID, title: "Light theme for the dashboard", project_identity: P1, project_display: "magic-context", project_path: "/Users/dev/Work/magic-context", opencode_session_json: { id: SID }, pi_jsonl_path: null, messages_count: 6, cache_events_count: 48, historian_runs: 2, compartments, facts, notes, meta, token_breakdown: tokenBreakdown, pi_compaction_entries: [] };
const messages = [
  ["user", "Add a light theme to the dashboard. Dark interfaces are hard for me to look at."],
  ["assistant", "I'll move remaining colours to tokens, add a System/Light/Dark picker and verify contrast."],
  ["tool", "read packages/dashboard/src/styles.css (2946 lines)"],
  ["assistant", "Token survey done: 22 hard-coded rgba() tints, 6 shadows, 1 SVG chevron."],
  ["user", "Make sure charts read the active theme."],
  ["assistant", "Charts use --chart-* tokens now; screenshots follow."],
].map(([role, text], i) => ({ message_id: `msg_${String(i + 230).padStart(6, "0")}`, timestamp_ms: NOW - (6 - i) * 3 * MIN, role, text_preview: text, raw_json: { role, text } }));
const historian = [
  { id: 41, session_id: SID, harness: "opencode", subagent: "historian", task: "compartmentalise", provider_id: "anthropic", model_id: "claude-sonnet-4-5", started_at: NOW - 2 * HOUR, ended_at: NOW - 2 * HOUR + 41_000, status: "completed", input_tokens: 48_210, output_tokens: 3_904, cache_read_tokens: 40_100, cache_write_tokens: 2_300, error: null, parent_invocation_id: null },
  { id: 42, session_id: SID, harness: "opencode", subagent: "historian-editor", task: "edit", provider_id: "anthropic", model_id: "claude-sonnet-4-5", started_at: NOW - 2 * HOUR + 42_000, ended_at: NOW - 2 * HOUR + 60_000, status: "completed", input_tokens: 12_004, output_tokens: 1_210, cache_read_tokens: 9_800, cache_write_tokens: 0, error: null, parent_invocation_id: 41 },
  { id: 43, session_id: SID, harness: "opencode", subagent: "historian", task: "compartmentalise", provider_id: "google", model_id: "gemini-3.8-flash", started_at: NOW - HOUR, ended_at: NOW - HOUR + 120_000, status: "timed_out", input_tokens: 51_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, error: "Provider did not answer within 120s", parent_invocation_id: null },
];
const subagentTotals = [
  { subagent: "historian", invocations: 2, total_input: 99_210, total_output: 3_904, total_cache_read: 40_100, total_cache_write: 2_300 },
  { subagent: "historian-editor", invocations: 1, total_input: 12_004, total_output: 1_210, total_cache_read: 9_800, total_cache_write: 0 },
];

function cacheEvents(harness: string, sessionId: string, count: number, seed: number) {
  const events = [];
  let prompt = 40_000;
  for (let i = 0; i < count; i++) {
    const limit = i < count * 0.3 ? 1_000_000 : 200_000;
    const drop = i === Math.floor(count * 0.6);
    if (drop) prompt = 52_000;
    prompt = Math.min(limit * 0.92, prompt + 2_500 + ((i * 7919 + seed) % 5_000));
    const r = (i * 31 + seed) % 23;
    const severity = i === 0 ? "warming" : r === 3 ? "bust" : r === 7 ? "warning" : r === 11 && i > 5 ? "full_bust" : i === count - 2 ? "unknown" : r === 15 ? "info" : "stable";
    const cacheRead = severity === "full_bust" ? 0 : severity === "bust" ? prompt * 0.35 : severity === "warning" ? prompt * 0.8 : severity === "warming" ? 0 : prompt * 0.96;
    events.push({ harness, message_id: `${sessionId}_m${i}`, session_id: sessionId, timestamp: NOW - (count - i) * 2 * MIN, input_tokens: Math.round(prompt - cacheRead), cache_read: Math.round(cacheRead), cache_write: 1_800, cache_reported: severity !== "unknown", total_tokens: Math.round(prompt + 900), hit_ratio: prompt ? cacheRead / prompt : 0, severity, cause: severity === "bust" || severity === "full_bust" ? (r % 2 ? "system_prompt_changed" : "mc_transform_failed_open") : drop ? "execute_threshold" : null, agent: "build", finish: "tool-calls", turn_id: `${sessionId}_t${Math.floor(i / 3)}`, is_turn_start: i % 3 === 0, context_limit: limit, context_limit_estimated: false, is_drop: drop, aggregate: false, cold_start: i === 0, cache_write_reported: true, provider: "anthropic", model: limit === 1_000_000 ? "claude-sonnet-4-5[1m]" : "claude-sonnet-4-5" });
  }
  return events;
}
const cacheStats = [
  { harness: "opencode", session_id: SID, event_count: 48, total_cache_read: 3_910_220, total_cache_write: 86_400, total_input: 4_812_330, hit_ratio: 0.91, last_timestamp: new Date(NOW - 4 * MIN).toISOString(), last_activity_ms: NOW - 4 * MIN, bust_count: 3, managed: true, is_subagent: false, title: "Light theme for the dashboard" },
  { harness: "pi", session_id: "pi_2b77e019", event_count: 30, total_cache_read: 1_220_000, total_cache_write: 41_000, total_input: 1_900_000, hit_ratio: 0.64, last_timestamp: new Date(NOW - 2 * HOUR).toISOString(), last_activity_ms: NOW - 2 * HOUR, bust_count: 6, managed: true, is_subagent: false, title: "Historian fallback chain refactor" },
  { harness: "claude_code", session_id: "cc_51d0aa", event_count: 22, total_cache_read: 410_000, total_cache_write: 30_000, total_input: 1_100_000, hit_ratio: 0.37, last_timestamp: new Date(NOW - 5 * HOUR).toISOString(), last_activity_ms: NOW - 5 * HOUR, bust_count: 9, managed: true, is_subagent: false, title: "Investigate cache bust after compaction" },
];
const cacheEventsBySession: Record<string, unknown[]> = { [SID]: cacheEvents("opencode", SID, 48, 3), pi_2b77e019: cacheEvents("pi", "pi_2b77e019", 30, 11), cc_51d0aa: cacheEvents("claude_code", "cc_51d0aa", 22, 5) };

const categories = ["ARCHITECTURE_DECISIONS", "CONSTRAINTS", "CONFIG_DEFAULTS", "NAMING", "WORKFLOW_RULES", "KNOWN_ISSUES"];
const memoryTexts = [
  "Dashboard colours are CSS custom properties; light and dark are two value sets on :root[data-theme].",
  "The dashboard CSP is script-src 'self' — no inline scripts, ship boot code from /assets.",
  "Default historian model is anthropic/claude-sonnet-4-5 with a gemini flash fallback.",
  "Use mason: prefix for worker commit messages.",
  "Run bun run test, typecheck and lint in packages/dashboard before committing.",
  "Serve mode only serves /assets/* — other paths fall back to index.html.",
  "Execute threshold defaults to 65% of the context window.",
  "Dreamer tasks are scheduled per project with cron expressions.",
];
const memories = memoryTexts.map((content, i) => ({ id: 100 + i, project_path: P1, category: categories[i % categories.length], content, normalized_hash: `h${i}`, source_session_id: SID, source_type: ["historian", "agent", "dreamer", "user"][i % 4], seen_count: 1 + (i % 5), retrieval_count: 3 * i, first_seen_at: NOW - (20 - i) * DAY, created_at: NOW - (20 - i) * DAY, updated_at: NOW - i * HOUR, last_seen_at: NOW - i * HOUR, last_retrieved_at: i % 3 ? NOW - i * HOUR : null, status: i === 6 ? "archived" : i === 1 ? "permanent" : "active", expires_at: null, verification_status: i % 2 ? "verified" : "unverified", verified_at: i % 2 ? NOW - DAY : null, superseded_by_memory_id: null, merged_from: null, metadata_json: null, importance: 30 + i * 8, scope: i % 3 === 0 ? "ecosystem" : "project", shareable: i % 2 === 0, has_embedding: i !== 3, source_display_name: "magic-context" }));
const memoryStats = { total: memories.length, active: 6, permanent: 1, archived: 1, with_embeddings: 7, categories: categories.map((category) => ({ category, count: memories.filter((m) => m.category === category).length })) };

const dreamerTasks = [
  { task: "map-memories", schedule: "0 3 * * *", last_run_at: NOW - 12 * HOUR, next_due_at: NOW + 11 * HOUR, last_status: "completed", last_error: null, retry_count: 0 },
  { task: "verify", schedule: "0 */6 * * *", last_run_at: NOW - 5 * HOUR, next_due_at: NOW + HOUR, last_status: "failed", last_error: "Provider timeout after 120s (google/gemini-3.8-flash)", retry_count: 2 },
  { task: "verify-broad", schedule: null, last_run_at: null, next_due_at: null, last_status: null, last_error: null, retry_count: 0 },
  { task: "curate", schedule: "30 4 * * 1", last_run_at: NOW - 2 * DAY, next_due_at: NOW + 5 * DAY, last_status: "completed", last_error: null, retry_count: 0 },
  { task: "compress-cues", schedule: "0 2 * * *", last_run_at: NOW - 13 * HOUR, next_due_at: NOW + 10 * HOUR, last_status: "skipped", last_error: null, retry_count: 0 },
  { task: "classify-memories", schedule: "15 1 * * *", last_run_at: NOW - 14 * HOUR, next_due_at: NOW + 9 * HOUR, last_status: "completed", last_error: null, retry_count: 0 },
];
const dreamerProjects = projectCards.map((p, i) => ({ identity: p.identity, label: p.display_name, worktree: p.primary_path, config_path: `${p.primary_path}/.cortexkit/magic-context.jsonc`, has_project_config: i === 0, tasks: i === 0 ? dreamerTasks : dreamerTasks.slice(0, 3) }));
const dreamRuns = [
  { id: 501, project_path: P1, started_at: NOW - 5 * HOUR, finished_at: NOW - 5 * HOUR + 4 * MIN, holder_id: "dreamer-01", tasks_json: [{ name: "verify", durationMs: 120_400, resultChars: 0, status: "failed", error: "Provider timeout after 120s", failure: { failure_class: "provider_timeout", model_attempted: "google/gemini-3.8-flash", models_tried: ["google/gemini-3.8-flash"], provider_error: "timeout", timeout_ms: 120000, child_session_id: null } }, { name: "map-memories", durationMs: 64_200, resultChars: 4_310, status: "completed", progress: "Mapped 42 memories", tokens: { total: 58_000, input: 52_000, output: 6_000, cache_read: 40_000, cache_write: 1_200 } }], tasks_succeeded: 1, tasks_failed: 1, smart_notes_surfaced: 1, smart_notes_pending: 1, memory_changes_json: { written: 3, archived: 1, merged: 2 } },
  { id: 500, project_path: P1, started_at: NOW - 29 * HOUR, finished_at: NOW - 29 * HOUR + 6 * MIN, holder_id: "dreamer-01", tasks_json: [{ name: "curate", durationMs: 210_000, resultChars: 9_100, status: "completed", progress: "Curated 18 memories" }, { name: "compress-cues", durationMs: 1_200, resultChars: 0, status: "skipped", skipReason: "No new compartments" }], tasks_succeeded: 1, tasks_failed: 0, smart_notes_surfaced: 0, smart_notes_pending: 2, memory_changes_json: { written: 1, deleted: 0, archived: 3 } },
];
const dreamRunMemoryChanges = { written: memories.slice(0, 3).map((m) => ({ id: m.id, category: m.category, content: m.content, status: "active" })), archived: memories.slice(6, 7).map((m) => ({ id: m.id, category: m.category, content: m.content, status: "archived" })), merged: memories.slice(3, 5).map((m) => ({ id: m.id, category: m.category, content: m.content, status: "active" })) };

const primers = [
  { id: 61, project_path: P1, question: "How does the dashboard choose its theme?", answer: "A boot script reads the saved preference (System by default) before the bundle loads and sets data-theme on <html>.", status: "active", total_support: 7, last_observed_at: NOW - HOUR, answer_refreshed_at: NOW - DAY, source_candidate_ids: "[71,72]", created_at: NOW - 4 * DAY, updated_at: NOW - DAY },
  { id: 62, project_path: P1, question: "Where is the dreamer schedule configured?", answer: "In magic-context.jsonc under dreamer.tasks, per task cron expressions.", status: "archived", total_support: 2, last_observed_at: NOW - 9 * DAY, answer_refreshed_at: null, source_candidate_ids: "[73]", created_at: NOW - 12 * DAY, updated_at: NOW - 9 * DAY },
];
const primerCandidates = [{ id: 74, project_path: P1, question: "Which tokens do charts read?", session_id: SID, source_compartment_start: 121, source_compartment_end: 160, source_message_time: NOW - 2 * HOUR, created_at: NOW - 2 * HOUR }];

const workspaces = [{ id: 1, name: "CortexKit", created_at: NOW - 30 * DAY, updated_at: NOW - 2 * DAY, share_categories: ["PROJECT_RULES", "ARCHITECTURE", "NAMING"], members: [{ project_path: P1, display_name: "magic-context", display_path: "~/Work/magic-context", memory_count: 212, added_at: NOW - 30 * DAY }, { project_path: P2, display_name: "agent-file-tools", display_path: "~/Work/aft", memory_count: 87, added_at: NOW - 20 * DAY }] }];
const userMemories = [
  { id: 81, content: "Prefers light interfaces; dark themes are hard to read.", status: "active", promoted_at: NOW - 3 * DAY, source_candidate_ids: [91, 92], created_at: NOW - 3 * DAY, updated_at: NOW - 3 * DAY },
  { id: 82, content: "Wants verification evidence (tests, screenshots) with every change.", status: "active", promoted_at: NOW - 10 * DAY, source_candidate_ids: [93], created_at: NOW - 10 * DAY, updated_at: NOW - 10 * DAY },
  { id: 83, content: "Used to prefer terse commit messages.", status: "dismissed", promoted_at: NOW - 40 * DAY, source_candidate_ids: null, created_at: NOW - 40 * DAY, updated_at: NOW - 20 * DAY },
];
const userCandidates = [{ id: 94, content: "Asks for WCAG AA contrast on new UI.", session_id: SID, source_compartment_start: 43, source_compartment_end: 120, created_at: NOW - HOUR }];

const components = ["event", "transform", "dreamer", "historian", "nudge", "note-nudge", "config"];
const logEntries = Array.from({ length: 28 }, (_, i) => {
  const component = components[i % components.length];
  const hit = component === "transform" ? [0.97, 0.62, 0.21][i % 3] : null;
  const ts = new Date(NOW - (28 - i) * 40_000).toISOString();
  return { timestamp: ts, level: i % 9 === 4 ? "WARN" : "INFO", component, logger: `magic-context.${component}`, session_id: i % 4 === 3 ? "" : SID, tags: [], bound: {}, message: `${component}: ${["applied 3 drops, prompt 122,840 tokens", "cache read 118,204 / write 1,800", "scheduled verify for magic-context", "compartmentalised messages 211-236", "nudge band medium at 61%", "surfaced smart note #31", "reloaded magic-context.jsonc"][i % 7]}`, kv: {}, raw: "", cache_read: hit == null ? null : 100_000, cache_write: hit == null ? null : 1_800, hit_ratio: hit };
});

const userConfig = `{
  // Shared CortexKit user config
  "enabled": true,
  "language": "en",
  "cache_ttl": "5m",
  "execute_threshold_percentage": 65,
  "embedding": { "provider": "openai-compatible", "endpoint": "https://openrouter.ai/api/v1", "model": "qwen/qwen3-embedding-8b" },
  "historian": { "opencode": { "model": { "model": "anthropic/claude-sonnet-4-5", "variant": "high" }, "fallback_models": [ { "model": "google/antigravity-gemini-3.8-flash" }, "openai/gpt-5" ] } },
  "dreamer": { "enabled": true, "opencode": { "model": "google/antigravity-gemini-3.8-flash", "fallback_models": [ "openai/gpt-5" ] } },
  "prompt_surface": { "models": { "anthropic/*": "full", "openrouter/qwen/qwen3-235b-a22b": "light" } },
  "pi": { "subagent_extensions": ["extensions/project-specific-tooling.ts"] }
}
`;
const projectConfig = `{
  "dreamer": { "tasks": { "verify": { "schedule": "0 */6 * * *" }, "curate": { "schedule": "30 4 * * 1" } } }
}
`;
const catalogs = {
  opencode: ["anthropic/claude-sonnet-4-5", "google/antigravity-gemini-3.8-flash", "deepseek/deepseek-flash", "openai/gpt-5", "openrouter/qwen/qwen3-235b-a22b"],
  pi: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
  omp: ["opencode-zen/gpt-5"],
  opencodeVariants: { "anthropic/claude-sonnet-4-5": ["low", "high", "adaptive"], "google/antigravity-gemini-3.8-flash": [] },
};
const dbHealth = { exists: true, path: "/fixture/context.db", size_bytes: 48_211_200, wal_size_bytes: 1_048_576, table_counts: [{ table_name: "memories", row_count: 313 }, { table_name: "compartments", row_count: 1_942 }, { table_name: "session_facts", row_count: 611 }, { table_name: "notes", row_count: 48 }] };

const responses: Record<string, unknown> = {
  get_db_health: dbHealth, get_model_catalogs: catalogs, get_opencode_install_state: "cli",
  get_project_cards: projectCards, get_projects: projects, enumerate_memory_projects: memoryProjects, enumerate_projects: memoryProjects,
  list_sessions_paged: { rows: sessionRows, total: sessionRows.length, has_more: false, conditions: [] },
  get_session_detail: sessionDetail, get_session_messages: messages, get_smart_notes: smartNotes,
  get_subagent_invocations: historian, get_subagent_totals_by_subagent: subagentTotals,
  get_memories: memories, get_memory_stats: memoryStats, get_mural: null, list_workspace_summaries: [{ id: 1, name: "CortexKit" }],
  get_dreamer_projects: dreamerProjects, get_dream_state: [], get_dream_runs: dreamRuns, get_dream_run_memory_changes: dreamRunMemoryChanges, get_task_schedule_state: [],
  get_primers: primers, get_primer_candidates: primerCandidates,
  get_session_cache_stats_from_db: cacheStats,
  workspace_schema_ready: true, list_workspaces: workspaces,
  get_user_memories: userMemories, get_user_memory_candidates: userCandidates,
  get_project_configs: projectCards.slice(0, 2).map((p) => ({ project_name: p.display_name, worktree: p.primary_path, config_path: `${p.primary_path}/.cortexkit/magic-context.jsonc`, exists: true })),
  get_log_entries: logEntries, get_log_paths: ["/fixture/logs/magic-context.log"],
};

const preload = (theme: string | null, showUpdate: boolean) => `(() => {
  const responses = ${JSON.stringify(responses)};
  const cacheEvents = ${JSON.stringify(cacheEventsBySession)};
  const userConfig = ${JSON.stringify(userConfig)};
  const projectConfig = ${JSON.stringify(projectConfig)};
  try {
    ${theme === "keep" ? "" : theme === null ? "localStorage.removeItem('magic-context-dashboard.theme');" : `localStorage.setItem('magic-context-dashboard.theme', ${JSON.stringify(theme)});`}
    localStorage.removeItem('magic-context-dashboard.config-tab');
  } catch {}
  // Record the theme attribute at the moment <body> is inserted: proves the
  // palette is chosen before anything in the body can paint.
  window.__themeAtBody = 'body-not-seen';
  new MutationObserver((records, observer) => {
    if (document.body) {
      window.__themeAtBody = document.documentElement.getAttribute('data-theme');
      window.__bgAtBody = getComputedStyle(document.documentElement).backgroundColor;
      observer.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
  const RealDate = Date;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:updater|check') return ${showUpdate ? "{ rid: 1, currentVersion: '0.19.0', version: '0.20.0', date: null, body: 'Light theme', rawJson: {} }" : "null"};
      if (cmd === 'get_config') return args && args.source === 'project'
        ? { path: (args.projectPath || '/fixture') + '/.cortexkit/magic-context.jsonc', exists: true, content: projectConfig, source: 'project', error: null }
        : { path: '/Users/dev/.config/cortexkit/magic-context.jsonc', exists: true, content: userConfig, source: 'user', error: null };
      if (cmd === 'read_pi_config') return { path: '/Users/dev/.pi/config.json', exists: false, content: null, source: 'pi', error: null };
      if (cmd.startsWith('get_session_cache_events')) return cacheEvents[args.sessionId] || [];
      if (cmd.startsWith('plugin:')) return null;
      return cmd in responses ? responses[cmd] : [];
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})()`;

const vite = Bun.spawn(["timeout", "570s", join(dashboard, "node_modules/.bin/vite"), "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { cwd: dashboard, stdout: "pipe", stderr: "inherit" });
const chrome = Bun.spawn(["timeout", "570s", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${join(root, "..", "chrome-profile")}`, "about:blank"], { stdout: "ignore", stderr: "pipe" });
let socket: WebSocket | undefined;
const screenshots: string[] = [];
const checks: string[] = [];
const contrastFindings: Record<string, unknown[]> = {};
const foreignSurfaces: Record<string, unknown[]> = {};
try {
  let ready = "";
  for await (const chunk of vite.stdout) {
    ready += new TextDecoder().decode(chunk);
    if (ready.includes(`http://127.0.0.1:${PORT}`)) break;
  }
  let endpoint = "";
  let output = "";
  for await (const chunk of chrome.stderr) {
    output += new TextDecoder().decode(chunk);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
    if (match) { endpoint = match[1]; break; }
  }
  if (!endpoint) throw new Error("Chrome debugging endpoint unavailable");
  socket = new WebSocket(endpoint);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error("Chrome connection failed")); });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> => new Promise((done, fail) => {
    const command = ++id;
    const timer = setTimeout(() => { pending.delete(command); fail(new Error(`${method} timed out`)); }, 30000);
    pending.set(command, { resolve: (value) => { clearTimeout(timer); done(value as T); }, reject: (error) => { clearTimeout(timer); fail(error); } });
    socket!.send(JSON.stringify({ id: command, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const version = await send<{ product: string }>("Browser.getVersion");
  console.log(version.product);

  let sid = "";
  let preloadId = "";
  const openTab = async () => {
    const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const attached = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    sid = attached.sessionId;
    await send("Page.enable", {}, sid);
  };
  const evaluate = async <T>(expression: string) => {
    const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
    if (result.exceptionDetails) throw new Error(`${expression.slice(0, 120)} → ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const assert = async (name: string, expression: string) => {
    if (!(await evaluate<boolean>(expression))) throw new Error(`Browser check failed: ${name}`);
    checks.push(name);
  };
  const frame = () => evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
  const settle = async () => { await frame(); await evaluate("new Promise(done => setTimeout(done, 250))"); await frame(); };
  const waitFor = (selector: string) => evaluate(`new Promise((done, fail) => { const observer=new MutationObserver(check); function check(){if(document.querySelector(${JSON.stringify(selector)})){observer.disconnect();done(true)}} observer.observe(document,{childList:true,subtree:true});check();setTimeout(()=>{observer.disconnect();fail(new Error('selector not reached: '+${JSON.stringify(selector)}))},15000) })`);
  const clickText = async (selector: string, text: string) => {
    await evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)})); if(!el) throw new Error('missing '+${JSON.stringify(selector)}+' '+${JSON.stringify(text)}); el.scrollIntoView({block:'center'}); el.click(); })()`);
    await settle();
  };
  const click = async (selector: string) => {
    await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('missing '+${JSON.stringify(selector)}); el.click(); })()`);
    await settle();
  };
  const setOsAppearance = (scheme: "light" | "dark") =>
    send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, sid);
  const load = async (theme: string | null, os: "light" | "dark", width: number, showUpdate = false) => {
    if (preloadId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preloadId }, sid);
    preloadId = (await send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: preload(theme, showUpdate) }, sid)).identifier;
    await send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sid);
    await setOsAppearance(os);
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sid);
    await waitFor(".nav-theme-option");
    await settle();
  };

  // Rendered-text contrast audit: for every visible element that directly holds
  // text, composite the backgrounds behind it (including translucent tints and
  // ancestor opacity) and compute the WCAG ratio against its text colour.
  const contrastAudit = `(() => {
    const parse = (value) => {
      let m = /rgba?\\(([^)]+)\\)/.exec(value);
      if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
      m = /color\\(srgb ([^)]+)\\)/.exec(value);
      if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return [p[0]*255, p[1]*255, p[2]*255, p[3] ?? 1]; }
      return null;
    };
    const over = (top, under) => { const a = top[3]; return [top[0]*a + under[0]*(1-a), top[1]*a + under[1]*(1-a), top[2]*a + under[2]*(1-a), 1]; };
    const lum = (c) => { const f = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
    const backdropOf = (el) => {
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const s = getComputedStyle(node);
        if (s.backgroundImage && s.backgroundImage !== 'none' && !s.backgroundImage.startsWith('url')) return null; // gradient: skip
        const c = parse(s.backgroundColor);
        if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
      }
      let base = parse(getComputedStyle(document.documentElement).backgroundColor) || [255,255,255,1];
      if (base[3] < 1) base = over(base, [255,255,255,1]);
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const findings = [];
    let checked = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (!['SPAN','DIV','P','BUTTON','A','LABEL','TD','TH','H1','H2','H3','STRONG','CODE','PRE','LI','SUMMARY','LEGEND','OPTION','EM','SMALL','B'].includes(el.tagName)) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!own) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden') continue;
      if (el.closest('[disabled], .dreamer-task-card.off, [aria-disabled="true"]')) continue; // WCAG exempts inactive controls
      let opacity = 1;
      for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      if (opacity === 0) continue;
      const bg = backdropOf(el);
      const fg = parse(s.color);
      if (!bg || !fg) continue;
      const effective = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const min = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const r = ratio(effective, bg);
      checked++;
      if (r < min) findings.push({ text: el.textContent.trim().slice(0, 60), class: String(el.className).slice(0, 60), ratio: Math.round(r*100)/100, min, color: s.color, opacity: Math.round(opacity*100)/100 });
    }
    return { checked, findings };
  })()`;

  const capture = async (theme: string, width: number, name: string) => {
    await settle();
    const result = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
    const path = join(root, `${theme}-${width}-${name}.png`);
    writeFileSync(path, Buffer.from(result.data, "base64"));
    screenshots.push(path);
    const applied = await evaluate<string>("document.documentElement.getAttribute('data-theme')");
    if (applied !== theme) throw new Error(`${name}: expected data-theme=${theme}, got ${applied}`);
    if (await evaluate<boolean>("!!document.querySelector('.error-boundary')")) throw new Error(`${name}: page rendered the error boundary`);
    const audit = await evaluate<{ checked: number; findings: unknown[] }>(contrastAudit);
    contrastFindings[`${theme}-${width}-${name}`] = audit.findings;
    // Surfaces painted in the opposite theme's palette (a dark panel on a light
    // page or the reverse) reveal colours that never went through a token.
    const foreign = await evaluate<unknown[]>(`(() => {
      const light = ${JSON.stringify(theme)} === 'light';
      const lum = (c) => { const f = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 2500 || r.bottom < 0 || r.top > innerHeight) continue;
        const m = /rgba?\\(([^)]+)\\)/.exec(getComputedStyle(el).backgroundColor);
        if (!m) continue;
        const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
        if ((p[3] ?? 1) < 0.5) continue;
        const L = lum(p);
        if (light ? L < 0.2 : L > 0.5) out.push({ class: String(el.className).slice(0, 60), tag: el.tagName, bg: getComputedStyle(el).backgroundColor, area: Math.round(r.width * r.height) });
      }
      return out;
    })()`);
    foreignSurfaces[`${theme}-${width}-${name}`] = foreign;
    if (foreign.length) console.log(`  foreign-palette surfaces: ${JSON.stringify(foreign.slice(0, 5))}`);
    console.log(`${theme}-${width}-${name}: ${audit.checked} text elements, ${audit.findings.length} below AA`);
  };

  await openTab();

  // 1. No flash: the attribute is set before <body> is parsed, for every
  //    stored preference and OS appearance.
  for (const stored of [null, "system", "light", "dark"]) {
    for (const os of ["light", "dark"] as const) {
      await load(stored, os, 1280);
      const expected = stored === "light" || stored === "dark" ? stored : os;
      await assert(`stored=${stored} os=${os}: data-theme=${expected} before <body>`, `window.__themeAtBody === ${JSON.stringify(expected)}`);
      const bg = expected === "light" ? "rgb(244, 241, 236)" : "rgb(10, 10, 15)";
      await assert(`stored=${stored} os=${os}: page background already ${bg} before <body>`, `window.__bgAtBody === ${JSON.stringify(bg)}`);
    }
  }
  // 2. System follows a live OS switch; explicit choices ignore it.
  await load(null, "dark", 1280);
  await assert("default preference is System", "document.querySelector('.nav-theme-option.active').textContent.trim()==='System' && document.querySelector('.nav-theme-option[aria-pressed=\"true\"]').textContent.trim()==='System'");
  await setOsAppearance("light"); await settle();
  await assert("System: OS switch to light repaints light", "document.documentElement.getAttribute('data-theme')==='light' && getComputedStyle(document.body).backgroundColor==='rgb(244, 241, 236)'");
  await setOsAppearance("dark"); await settle();
  await assert("System: OS switch back to dark repaints dark", "document.documentElement.getAttribute('data-theme')==='dark' && getComputedStyle(document.body).backgroundColor==='rgb(10, 10, 15)'");
  await clickText(".nav-theme-option", "Light");
  await assert("picker: Light applies immediately and persists", "document.documentElement.getAttribute('data-theme')==='light' && localStorage.getItem('magic-context-dashboard.theme')==='light'");
  await setOsAppearance("dark"); await settle();
  await assert("explicit Light ignores the OS being dark", "document.documentElement.getAttribute('data-theme')==='light'");
  // "keep" leaves the stored preference alone, so this reload reads what the picker wrote.
  await load("keep", "dark", 1280);
  await assert("picker choice survives a reload", "document.documentElement.getAttribute('data-theme')==='light' && document.querySelector('.nav-theme-option.active').textContent.trim()==='Light'");
  await clickText(".nav-theme-option", "System");
  await assert("picker: back to System follows the (dark) OS", "document.documentElement.getAttribute('data-theme')==='dark' && localStorage.getItem('magic-context-dashboard.theme')==='system'");

  // 3. Screens: every page, both themes, every width.
  for (const theme of ["light", "dark"] as const) {
    for (const width of widths) {
      await load(theme, theme === "light" ? "dark" : "light", width, true);
      await waitFor(".project-card");
      await waitFor(".update-toast");
      await capture(theme, width, "01-projects-update-toast");
      await click(".update-toast .btn:not(.primary)");
      await evaluate("document.querySelector('.project-card').focus()");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sid);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sid);
      await capture(theme, width, "02-projects-focus-ring");
      await click(".project-card");
      await waitFor(".project-detail-body .card");
      await capture(theme, width, "03-project-sessions");
      await click(".project-detail-body .scroll-area button.card");
      await waitFor(".tab-pill");
      await clickText(".tab-pill", "Compartments");
      await evaluate("document.querySelector('.timeline-segment')?.click()");
      await capture(theme, width, "04-session-compartments");
      await clickText(".tab-pill", "Messages");
      await capture(theme, width, "05-session-messages");
      await clickText(".tab-pill", "Facts");
      await capture(theme, width, "06-session-facts");
      await clickText(".tab-pill", "Notes");
      await capture(theme, width, "07-session-notes");
      await clickText(".tab-pill", "Historian");
      await capture(theme, width, "08-session-historian");
      await clickText(".tab-pill", "Meta");
      await evaluate("[...document.querySelectorAll('.card-title')].find(e=>e.textContent.includes('Context Token Breakdown'))?.scrollIntoView({block:'start'})");
      await capture(theme, width, "09-session-meta-chart");
      await click(".section-header .btn.sm");
      await clickText(".project-tab", "Memories");
      await waitFor(".memory-card");
      await capture(theme, width, "10-project-memories");
      await evaluate("document.querySelector('.memory-card-checkbox input').click()");
      await settle();
      await capture(theme, width, "11-memories-bulk-select");
      await evaluate("document.querySelector('.memory-card-checkbox input').click()");
      await click(".memory-card .memory-card-body");
      await waitFor(".slide-panel");
      await capture(theme, width, "12-memory-detail-panel");
      await click(".slide-panel-backdrop");
      await clickText(".project-tab", "Dreamer");
      await waitFor(".dreamer-task-card");
      await capture(theme, width, "13-project-dreamer-cards");
      await evaluate("document.querySelector('.dream-run-card, .dream-run-flat-table')?.scrollIntoView({block:'start'})");
      await evaluate("document.querySelector('.dream-run-flat-row.clickable')?.click()");
      await capture(theme, width, "14-dreamer-run-history");
      await click(".dreamer-gear");
      await waitFor(".modal-card");
      await capture(theme, width, "15-dreamer-config-dialog");
      await click(".modal-backdrop");
      await clickText(".project-tab", "Primers");
      await capture(theme, width, "16-project-primers");
      await click('.nav-item[title="Cache"]');
      await waitFor(".ctx-bar");
      await capture(theme, width, "17-cache-diagnostics");
      await evaluate("document.querySelector('.scroll-area').scrollTop = 420");
      await capture(theme, width, "18-cache-diagnostics-steps");
      await click('.nav-item[title="Workspaces"]');
      await capture(theme, width, "19-workspaces");
      await click('.nav-item[title="User Directives"]');
      await capture(theme, width, "20-user-directives");
      await click('.nav-item[title="Config"]');
      await waitFor(".config-section-panel");
      await capture(theme, width, "21-config-general");
      for (const [index, section] of [["22", "Context window"], ["23", "Background models"], ["24", "Dreamer schedule"], ["25", "Prompt surface"]] as const) {
        await evaluate(`[...document.querySelectorAll('.config-section-index button')].find(b=>b.textContent.includes(${JSON.stringify(section)})).click()`);
        await settle();
        await capture(theme, width, `${index}-config-${section.toLowerCase().replaceAll(" ", "-")}`);
      }
      await evaluate("[...document.querySelectorAll('.config-section-index button')].find(b=>b.textContent.includes('Context window')).click()");
      await settle();
      await evaluate("document.querySelector('.config-help-button')?.click()");
      await capture(theme, width, "26-config-help-popover");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sid);
      await evaluate("[...document.querySelectorAll('.config-section-index button')].find(b=>b.textContent.includes('Background models')).click()");
      await settle();
      await evaluate("document.querySelector('.config-section-panel .model-select-trigger').click()");
      await capture(theme, width, "27-config-model-picker");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sid);
      await clickText(".config-segmented button", "Raw JSONC");
      await capture(theme, width, "28-config-raw-jsonc");
      await evaluate("[...document.querySelectorAll('.btn.sm')].find(b=>b.textContent.trim()==='Edit')?.click()");
      await capture(theme, width, "29-config-raw-editor");
      await click('.nav-item[title="Logs"]');
      await waitFor(".cache-bar");
      await capture(theme, width, "30-logs");
    }
  }
  const lightFindings = Object.entries(contrastFindings).filter(([name, list]) => name.startsWith("light") && list.length);
  writeFileSync(join(root, "..", "theme-browser-report.json"), JSON.stringify({ browser: version.product, checks, screenshots, contrastFindings, foreignSurfaces }, null, 2));
  console.log(`PASS: ${checks.length} browser checks; ${screenshots.length} screenshots in ${root}`);
  console.log(`Light-theme rendered text below AA on ${lightFindings.length} screens`);
  for (const [name, list] of lightFindings) console.log(name, JSON.stringify(list));
} finally {
  socket?.close();
  chrome.kill(); vite.kill();
  await Promise.all([chrome.exited, vite.exited]);
}
