import { configDefault } from "./config-schema";

export interface TaskMeta {
  name: string;
  label: string;
  description: string;
  defaultSchedule: string;
}

// Mirrors CANONICAL_DREAM_TASKS + DEFAULT_TASK_SCHEDULES in the plugin schema.
export const TASKS: TaskMeta[] = [
  {
    name: "map-memories",
    label: "Map memories",
    description: "Maps each memory to its backing files so verify knows what to re-check",
    defaultSchedule: String(configDefault("dreamer.tasks.map-memories.schedule")),
  },
  {
    name: "verify",
    label: "Verify changed memories",
    description: "Checks changed-file memories against code and fixes/removes stale ones",
    defaultSchedule: String(configDefault("dreamer.tasks.verify.schedule")),
  },
  {
    name: "verify-broad",
    label: "Verify all memories",
    description: "Periodic full re-check of the whole memory pool (catches drift)",
    defaultSchedule: String(configDefault("dreamer.tasks.verify-broad.schedule")),
  },
  {
    name: "curate",
    label: "Curate memories",
    description: "Deduplicates, tightens, and prunes the memory pool",
    defaultSchedule: String(configDefault("dreamer.tasks.curate.schedule")),
  },
  {
    name: "compress-cues",
    label: "Compress mural cues",
    description:
      "Compresses each overflow memory into a mural cue (the mural image renders deterministically)",
    defaultSchedule: String(configDefault("dreamer.tasks.compress-cues.schedule")),
  },
  {
    name: "classify-memories",
    label: "Classify memories",
    description: "Scores memory importance, scope, and shareability",
    defaultSchedule: String(configDefault("dreamer.tasks.classify-memories.schedule")),
  },
  {
    name: "retrospective",
    label: "Retrospective",
    description: "Learns from moments you had to correct or re-explain, and records the lesson",
    defaultSchedule: String(configDefault("dreamer.tasks.retrospective.schedule")),
  },
  {
    name: "maintain-docs",
    label: "Maintain docs",
    description: "Keep ARCHITECTURE.md / STRUCTURE.md in sync",
    defaultSchedule: String(configDefault("dreamer.tasks.maintain-docs.schedule")),
  },
  {
    name: "evaluate-smart-notes",
    label: "Evaluate smart notes",
    description: "Surface smart notes whose conditions are now met",
    defaultSchedule: String(configDefault("dreamer.tasks.evaluate-smart-notes.schedule")),
  },
  {
    name: "review-user-memories",
    label: "Review user memories",
    description: "Promote recurring behaviors into your user profile",
    defaultSchedule: String(configDefault("dreamer.tasks.review-user-memories.schedule")),
  },
  {
    name: "promote-primers",
    label: "Promote primers",
    description: "Promote recurring project questions into Primers",
    defaultSchedule: String(configDefault("dreamer.tasks.promote-primers.schedule")),
  },
  {
    name: "refresh-primers",
    label: "Refresh primers",
    description: "Refresh answers for active project Primers",
    defaultSchedule: String(configDefault("dreamer.tasks.refresh-primers.schedule")),
  },
];
