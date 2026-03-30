// ─── Composition ─────────────────────────────────────────────────────────────
export const COMP_WIDTH = 1280;
export const COMP_HEIGHT = 720;
export const FPS = 30;

// Full animation: 45s = 1350 frames
export const FULL_DURATION_FRAMES = 2386;
// GIF loop: 27.5s = 826 frames (Scenes 0-2)
export const LOOP_DURATION_FRAMES = 826;

// ─── Layout ───────────────────────────────────────────────────────────────────
export const PANEL_W = 660;
export const PANEL_H = 460;

// ─── Pacing ───────────────────────────────────────────────────────────────────
export const INTRO_DURATION = 75; // 2.5s narrative title card before scene

// ─── Scene durations (frames) ─────────────────────────────────────────────────
export const SCENE_0_DURATION = 316; // 10.5s
export const SCENE_1_DURATION = 225; // 7.5s (75 intro + 150 ui)
export const SCENE_2_DURATION = 285; // 9.5s (75 intro + 210 ui)
export const SCENE_3_DURATION = 465; // 15.5s (75 intro + 390 ui)
export const SCENE_4_DURATION = 315; // 10.5s (75 intro + 240 ui)
export const SCENE_5_DURATION = 345; // 11.5s (75 intro + 270 ui)
export const SCENE_6_DURATION = 255; // 8.5s (75 intro + 180 ui)
export const SCENE_7_DURATION = 180; // 6s

// ─── Per-message stagger ─────────────────────────────────────────────────────
export const MESSAGE_STAGGER = 10;
export const MESSAGE_STAGGER_FAST = 4; // For time-lapse scenes

// ─── Colors (Dark Theme) ─────────────────────────────────────────────────────
export const COLORS = {
  // Backgrounds
  bg: "#0a0f1e",                // deep navy
  panelBg: "#0f172a",           // slate-900
  panelBorder: "#1e293b",       // slate-800

  // Text
  textPrimary: "#f1f5f9",       // slate-100
  textSecondary: "#94a3b8",     // slate-400
  textMuted: "#475569",         // slate-600

  // Message bars
  userBar: "#1e40af",           // blue-800
  assistantBar: "#1e293b",      // slate-800

  // Tags
  tagColor: "#6366f1",          // indigo-500
  tagBg: "rgba(99,102,241,0.12)",

  // Context bar
  contextGreen: "#22c55e",
  contextAmber: "#f59e0b",
  contextRed: "#ef4444",
  contextTrack: "#1e293b",

  // Selection/highlight
  selectionOutline: "#6366f1",
  selectionBg: "rgba(99,102,241,0.06)",

  // Historian
  historianAccent: "#a78bfa",    // violet-400
  historianBg: "#1a1033",
  historianBorder: "#2e1065",

  // Compartment
  compartmentAccent: "#34d399",  // emerald-400
  compartmentBg: "#062320",
  compartmentBorder: "#064e3b",

  // Nudges
  nudgeAmber: "#f59e0b",
  nudgeRed: "#ef4444",

  // Memory
  memoryAccent: "#60a5fa",       // blue-400
  memoryBg: "#0c1a2e",

  // Dreamer
  dreamerAccent: "#818cf8",      // indigo-400
  dreamerBg: "#0c0f24",

  // Success
  successText: "#34d399",

  // Command chip
  commandBg: "#1e293b",
  commandBorder: "#334155",
  commandText: "#e2e8f0",
} as const;

// ─── Typography ────────────────────────────────────────────────────────────────
export const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
export const FONT_FAMILY_MONO =
  "'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, monospace";

// ─── Skeleton message definitions ─────────────────────────────────────────────
export type Role = "user" | "assistant";

export type SkeletonDef = {
  id: number;
  role: Role;
  tag: number;
  /** Bar width as % of container (50–92) */
  barWidth: number;
  /** Optional: mark as large (tool output) */
  isLarge?: boolean;
  /** Optional: label for tool outputs */
  label?: string;
};

// Standard messages for scenes
export const SKELETON_MESSAGES: SkeletonDef[] = [
  { id: 1, role: "user", tag: 1, barWidth: 62 },
  { id: 2, role: "assistant", tag: 2, barWidth: 88 },
  { id: 3, role: "user", tag: 3, barWidth: 54 },
  { id: 4, role: "assistant", tag: 4, barWidth: 84 },
  { id: 5, role: "user", tag: 5, barWidth: 68 },
  { id: 6, role: "assistant", tag: 6, barWidth: 90, isLarge: true, label: "grep results" },
  { id: 7, role: "user", tag: 7, barWidth: 58 },
  { id: 8, role: "assistant", tag: 8, barWidth: 82, isLarge: true, label: "file read" },
];

// Messages with tool outputs for Scene 2 (reduce demonstration)
export const SCENE2_MESSAGES: SkeletonDef[] = [
  { id: 1, role: "user", tag: 1, barWidth: 62 },
  { id: 2, role: "assistant", tag: 2, barWidth: 88 },
  { id: 3, role: "user", tag: 3, barWidth: 54 },
  { id: 4, role: "assistant", tag: 4, barWidth: 84 },
  { id: 5, role: "user", tag: 5, barWidth: 68 },
  { id: 6, role: "assistant", tag: 6, barWidth: 90, isLarge: true, label: "grep results" },
  { id: 7, role: "user", tag: 7, barWidth: 58 },
  { id: 8, role: "assistant", tag: 8, barWidth: 82, isLarge: true, label: "file read" },
];

// Old messages for historian scene
export const OLD_MESSAGES: SkeletonDef[] = [
  { id: 1, role: "user", tag: 1, barWidth: 62 },
  { id: 2, role: "assistant", tag: 2, barWidth: 88 },
  { id: 3, role: "user", tag: 3, barWidth: 54 },
  { id: 4, role: "assistant", tag: 4, barWidth: 84 },
  { id: 5, role: "user", tag: 5, barWidth: 68 },
];

// Recent messages for historian scene
export const RECENT_MESSAGES: SkeletonDef[] = [
  { id: 6, role: "assistant", tag: 6, barWidth: 90 },
  { id: 7, role: "user", tag: 7, barWidth: 58 },
  { id: 8, role: "assistant", tag: 8, barWidth: 82 },
];

// Memory items for Scene 5
export const MEMORY_ITEMS = [
  "Auth uses JWT with 15min expiry, refresh tokens",
  "Postgres, not SQLite — migration in progress",
  "User prefers minimal comments in code",
];

// Dreamer pills for Scene 6
export const DREAMER_PILLS = [
  { icon: "🗜️", text: "Consolidate: merge similar memories", type: "success" },
  { icon: "✓", text: "Verify: check memories against codebase", type: "success" },
  { icon: "⊘", text: "Archive stale: retire removed features", type: "archive" },
  { icon: "✍️", text: "Improve: rewrite into terse facts", type: "success" },
  { icon: "📝", text: "Maintain docs: update ARCHITECTURE.md", type: "success" },
];
