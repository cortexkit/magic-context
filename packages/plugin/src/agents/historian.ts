/** The one-pass historian. */
export const HISTORIAN_AGENT = "historian";
/**
 * Both turns of a two-pass historian run. OpenCode 1 sends the system prompt
 * registered for the agent a request names, so the two-pass prompt needs its
 * own agent; a request naming `historian` would carry the one-pass prompt.
 */
export const HISTORIAN_TWO_PASS_AGENT = "historian-two-pass";
export const HISTORIAN_RECOMP_AGENT = "historian-recomp";
export const HISTORIAN_EDITOR_AGENT = "historian-editor";
