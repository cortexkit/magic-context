export const CTX_REDUCE_DESCRIPTION = `Reduce context by dropping tagged content you no longer need.
Use \u00a7N\u00a7 identifiers visible in conversation. The \`drop\` param accepts ranges: "3-5", "1,2,9", "1-5,8".

CRITICAL RULES:
- NEVER blanket-drop large ranges (e.g., "1-50"). Always review what each tag contains first.
- Only drop tool outputs you have already processed and no longer need.
- Protected tags are accepted but deferred until they leave the last protected range.
- Keep recent context — only reduce OLD content that is no longer relevant to current work.
- Dropped content is gone forever.`;
