### `episode_type` — describe the activities, do not let it drive boundaries

`episode_type` lists one or more comma-separated activities the compartment spanned. It is a **description** of the work, not a **boundary signal**. Include an activity type only if it materially shaped the work — a quick tangential touch of an activity (a one-line lint fix inside a feature arc) does NOT make that activity a type. Use the activities that meaningfully appeared:

⟦profile:episode-types⟧

Examples:
- Pure feature implementation: `episode_type="feature"`
- Designed and built a feature: `episode_type="design,feature"`
- Built a feature and shipped it: `episode_type="feature,release"`
- Investigation that resolved into a fix: `episode_type="investigation,bug"`
- Structural refactor that touched build tooling: `episode_type="refactor,infra"`
- Full design-build-document-release arc: `episode_type="design,feature,docs,release"`

**Do not split a compartment just because it spans multiple activity types.** That is exactly what multi-typed `episode_type` is for.

