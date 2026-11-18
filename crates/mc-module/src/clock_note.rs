//! The clock note: one line, `Now: <time>`, that ck-mc sends a session at
//! system authority on the agent's own tool turns, so an agent that runs for
//! hours on wakes, messages from other agents and long tool loops, without
//! the person typing, still knows what time it is.
//!
//! The note is a plan template with one `datetime` slot (llm-runner 0.8.62,
//! capability group `template_datetime`): ck-mc sends integer Unix seconds
//! and the runner renders `Wed 18 Nov 22:52Z` (UTC, English names, floored
//! to the minute). Nothing else goes in the note; the person's time zone is
//! in the system prompt.
//!
//! - **Readers first.** A note goes only to a session whose runner declares
//!   `template_datetime`. Any other runner gets none, and no fallback text.
//!   The template also sits in the plan sender ck-mc publishes
//!   ([`crate::nudges::plan_sender`]); core leaves it out of the plans of
//!   runners that don't declare the group, because such a runner refuses a
//!   plan holding a datetime slot.
//! - **Delivery.** `[turn_system, tool_result]`: a turn-scoped system message
//!   where the route takes one, otherwise appended to the next tool result.
//!   Both are persistent, so the history keeps a trail of times the
//!   summarizer can use, and both land only in bytes the provider has not
//!   cached yet. `turn_system` is listed only when the runner declares it.
//! - **When.** At most once per configured interval (`clock_note`, default
//!   30 minutes): due when the interval has passed since the session last
//!   got one, or when it never got one. ck-mc sends it only while the newest
//!   message is the model's own tool call, so it rides that call's result. A
//!   reply without a tool call gets none.
//! - **A plan without the template.** A session whose plan was composed
//!   before its runner declared the group has no clock template, and its
//!   runner refuses the send (`invalid_params`, field `template`). The
//!   session then gets no more notes until its next Setup, which may follow
//!   a plan change; the next due tool turn after it tries once more.

use std::collections::BTreeMap;

use cortexkit_role_llm_runner::delivery_order::{
    template_digest, DatetimeFormat, Mode, Slot, Template, TemplateUse,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Every clock-note send's `dedupe_key`, so a newer note replaces one the
/// runner still holds queued, and its `send_id` prefix.
pub const KIND: &str = "mc.clock_note";
/// The clock note's plan template.
pub const TEMPLATE: &str = "mc.clock_note.v1";
/// The interval when the configuration names none: 30 minutes.
pub const DEFAULT_INTERVAL_MS: u64 = 30 * MINUTE_MS;
const MINUTE_MS: u64 = 60 * 1_000;
/// The datetime slot takes values below this (2100-01-01T00:00:00Z).
const DATETIME_END_SECONDS: u64 = 4_102_444_800;

/// The template: `Now: {now}`, `now` a `utc_minute` datetime.
pub fn template() -> Template {
    Template::new(
        TEMPLATE,
        "Now: {now}",
        BTreeMap::from([(
            "now".to_owned(),
            Slot::Datetime {
                format: DatetimeFormat::UtcMinute,
            },
        )]),
    )
}

/// The note for the time `now_ms` (milliseconds since the Unix epoch), as
/// whole seconds.
pub fn note(now_ms: u64) -> TemplateUse {
    let seconds = (now_ms / 1_000).min(DATETIME_END_SECONDS - 1);
    TemplateUse::new(
        TEMPLATE,
        template_digest(&template()),
        Map::from_iter([("now".to_owned(), json!(seconds))]),
    )
}

/// The delivery order for a runner that declares `turn_system` or not.
pub fn delivery(turn_system: bool) -> Vec<Mode> {
    if turn_system {
        vec![Mode::TurnSystem, Mode::ToolResult]
    } else {
        vec![Mode::ToolResult]
    }
}

/// The current time in milliseconds since the Unix epoch. A test can fix it
/// for its own thread ([`set_test_now`]).
pub(crate) fn now_ms() -> u64 {
    #[cfg(test)]
    if let Some(now) = TEST_NOW.with(std::cell::Cell::get) {
        return now;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
thread_local! {
    static TEST_NOW: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Fix [`now_ms`] for the calling thread; `None` reads the system clock again.
#[cfg(test)]
pub(crate) fn set_test_now(now: Option<u64>) {
    TEST_NOW.with(|cell| cell.set(now));
}

/// The interval `clock_note` sets, in milliseconds: `None` when it is
/// `false` (the note is off). Otherwise a whole number of minutes or hours,
/// written like `"30m"` or `"1h"`, of at least one minute.
pub fn parse_interval(value: &Value) -> Result<Option<u64>, String> {
    let refuse = || {
        format!(
            "clock_note must be false or a duration in minutes or hours such as \"30m\" or \"1h\", not {value}"
        )
    };
    let text = match value {
        Value::Bool(false) => return Ok(None),
        Value::String(text) => text.trim(),
        _ => return Err(refuse()),
    };
    let (number, unit_ms) = if let Some(number) = text.strip_suffix('m') {
        (number, MINUTE_MS)
    } else if let Some(number) = text.strip_suffix('h') {
        (number, 60 * MINUTE_MS)
    } else {
        return Err(refuse());
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(refuse());
    }
    number
        .parse::<u64>()
        .ok()
        .filter(|count| *count > 0)
        .and_then(|count| count.checked_mul(unit_ms))
        .map(Some)
        .ok_or_else(refuse)
}

/// What a session keeps of its clock notes, across a restart and a quiet
/// free.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// When the runner last accepted a clock note for the session, in
    /// milliseconds since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sent_ms: Option<u64>,
    /// The runner refused a clock note because the session's plan holds no
    /// clock template. No note goes until the next Setup clears this.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub refused: bool,
}

impl State {
    /// Nothing to save: no note was ever sent or refused.
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    /// Whether a note is due at `now_ms` with `interval_ms` between notes. A
    /// clock that went backwards (a note recorded later than now) makes one
    /// due, so a wrong time is not kept for long.
    pub fn due(&self, now_ms: u64, interval_ms: u64) -> bool {
        !self.refused
            && self
                .last_sent_ms
                .is_none_or(|last| now_ms < last || now_ms.saturating_sub(last) >= interval_ms)
    }
}

/// Whether a runner refused a clock note because the session's plan holds
/// no such template: `invalid_params` naming the template.
pub fn plan_lacks_template(error: &crate::client::ClientError) -> bool {
    error.code.as_deref() == Some("invalid_params")
        && error
            .detail
            .as_ref()
            .and_then(|detail| detail.get("field"))
            .and_then(Value::as_str)
            == Some("template")
}

#[cfg(test)]
#[path = "clock_note_tests.rs"]
mod tests;
