export const LEXICAL_SLOT_COUNT = 2;
export const NEIGHBOUR_SHORTLIST_CAP = 12;
export const NARROW_CHECK_WINDOW_MAX = 1_200;
export const KEPT_CHECK_INPUT_MAX = 48_000;
export const NARROW_CHECK_CALL_CEILING = 8;
export const MAX_STAGE2_ATTEMPTS = 3;
export const RETRY_BACKLOG_PER_RUN = 8;
export const EXCERPT_BEFORE = 2;
export const EXCERPT_AFTER = 4;

export const CONCRETE_UNITS = [
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
] as const;
export const CLAUSE_ABBREVIATIONS = ["e.g.", "i.e.", "etc.", "vs."] as const;
