import { parseJsonc, patchConfigJsonc } from "../../lib/jsonc";

/**
 * Sections the structured form edits key by key. The form only exposes some of
 * their sub-keys, so they are merged one level deep instead of replaced; a
 * shallow merge would drop every sub-key the form doesn't show. A legacy
 * top-level `experimental` block (if any) is kept by the shallow merge and
 * relocated by the plugin's config migration on next load.
 */
const DEEP_MERGED_SECTIONS = [
  "embedding",
  "memory",
  "sqlite",
  "system_prompt_injection",
  "caveman_text_compression",
  "mural",
  "prompt_surface",
  "storage",
  "compaction",
  "pi",
  "dashboard",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The file text the structured config form saves: the form's values merged
 * over the file's current values, written back into the existing file so its
 * comments survive. Throws when `content` is not valid JSONC.
 */
export function structuredConfigSaveContent(
  content: string,
  formData: Record<string, unknown>,
): string {
  const original = parseJsonc(content);
  const merged: Record<string, unknown> = { ...original, ...formData };
  for (const key of DEEP_MERGED_SECTIONS) {
    const section = formData[key];
    if (isRecord(section)) {
      merged[key] = {
        ...(isRecord(original[key]) ? original[key] : {}),
        ...section,
      };
    }
  }
  return patchConfigJsonc(content, merged);
}
