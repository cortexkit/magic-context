/**
 * The per-project single-store marker.
 *
 * A row in `single_store_projects` says a project's memories and notes live only in
 * `context.db`, so the store.db mirror, drain and reconcile paths must not run for it.
 * No code in this release writes a row; it only reads them and refuses.
 */

/** The marker table's name. The Rust module's `MARKER_TABLE` is the same literal. */
export const MARKER_TABLE = "single_store_projects";

/**
 * The `context.db` migration version that creates the marker table.
 *
 * A file whose persisted migration lane is below this number has not run that
 * migration yet, so its projects are unmarked rather than unreadable. The Rust
 * module carries the same number as `MARKER_LANE_VERSION`.
 */
export const MARKER_LANE_VERSION = 93;
