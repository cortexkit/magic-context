//! Named limits and lists shared with the TypeScript memory applier
//! (`packages/plugin/src/features/magic-context/memory/lifecycle-constants.ts`).
//! Both sides assert the same values in their tests.

pub const LEXICAL_SLOT_COUNT: usize = 2;
pub const NEIGHBOUR_SHORTLIST_CAP: usize = 12;
/// UTF-16 code units, as JavaScript measures string length.
pub const NARROW_CHECK_WINDOW_MAX: usize = 1_200;
/// UTF-16 code units, as JavaScript measures string length.
pub const KEPT_CHECK_INPUT_MAX: usize = 48_000;
pub const NARROW_CHECK_CALL_CEILING: usize = 8;
pub const MAX_STAGE2_ATTEMPTS: i64 = 3;
pub const RETRY_BACKLOG_PER_RUN: usize = 8;
pub const EXCERPT_BEFORE: i64 = 2;
pub const EXCERPT_AFTER: i64 = 4;

/// Units a number may carry to form one concrete token (`64 KiB`, `50%`).
pub const CONCRETE_UNITS: &[&str] = &[
    "KiB",
    "MiB",
    "GiB",
    "TiB",
    "KB",
    "MB",
    "GB",
    "TB",
    "byte",
    "bytes",
    "ns",
    "us",
    "µs",
    "ms",
    "s",
    "sec",
    "secs",
    "millisecond",
    "milliseconds",
    "second",
    "seconds",
    "m",
    "min",
    "mins",
    "minute",
    "minutes",
    "h",
    "hour",
    "hours",
    "d",
    "day",
    "days",
    "w",
    "week",
    "weeks",
    "token",
    "tokens",
    "percent",
    "%",
];

/// Abbreviations whose final `.` never ends a clause.
pub const CLAUSE_ABBREVIATIONS: &[&str] = &["e.g.", "i.e.", "etc.", "vs."];

/// The month-scale lifetimes the TypeScript `CATEGORY_DEFAULT_TTL` gives historian
/// admissions, in milliseconds. Categories not listed never expire.
pub fn category_default_ttl_ms(category: &str) -> Option<i64> {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    match category {
        "WORKFLOW_RULES" => Some(90 * DAY_MS),
        "KNOWN_ISSUES" => Some(30 * DAY_MS),
        _ => None,
    }
}
