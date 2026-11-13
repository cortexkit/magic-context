//! Five-field cron (`minute hour day-of-month month day-of-week`) in the
//! machine's local time, the format the 0.49 dreamer's `schedule` settings
//! use, so a person's schedules mean the same thing under the module.
//!
//! The next due time is found by stepping real minutes and reading each one's
//! local wall-clock fields. A local time skipped by a daylight-saving change
//! never matches, and one repeated by it matches once: the minute is found on
//! its first occurrence, and [`next_due`] starts after the slot it was given.

use chrono::{Datelike, Local, TimeZone, Timelike};

const MINUTE: i64 = 60_000;
/// How far ahead a schedule is searched: four years covers every month and
/// weekday combination, a 29 February included.
const SEARCH: i64 = 4 * 366 * 24 * 60 * MINUTE;

/// A parsed expression: the allowed values of each field.
#[derive(Debug, PartialEq, Eq)]
pub struct Cron {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Vec<u32>,
    months: Vec<u32>,
    weekdays: Vec<u32>,
    /// Both day fields are restricted: standard cron then matches a day that
    /// satisfies either one, not both.
    either_day: bool,
}

fn number(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// One field's allowed values: `*`, a value, a range, a list, each with an
/// optional `/step`. Day-of-week accepts 7 for Sunday.
fn field(token: &str, min: u32, max: u32, weekday: bool) -> Option<Vec<u32>> {
    let mut values = Vec::new();
    for piece in token.split(',') {
        let (range, step) = match piece.split_once('/') {
            Some((range, step)) => (range, number(step)?),
            None => (piece, 1),
        };
        if step == 0 {
            return None;
        }
        let (low, high) = if range == "*" {
            (min, max)
        } else if let Some((low, high)) = range.split_once('-') {
            (number(low)?, number(high)?)
        } else {
            let value = number(range)?;
            (value, if piece.contains('/') { max } else { value })
        };
        if low < min || high > max || low > high {
            return None;
        }
        values.extend((low..=high).step_by(step as usize).map(|value| {
            if weekday && value == 7 {
                0
            } else {
                value
            }
        }));
    }
    values.sort_unstable();
    values.dedup();
    Some(values)
}

impl Cron {
    /// `None` for anything that isn't a valid five-field expression.
    pub fn parse(expression: &str) -> Option<Self> {
        let tokens: Vec<&str> = expression.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = tokens.as_slice() else {
            return None;
        };
        Some(Self {
            minutes: field(minute, 0, 59, false)?,
            hours: field(hour, 0, 23, false)?,
            days: field(day, 1, 31, false)?,
            months: field(month, 1, 12, false)?,
            weekdays: field(weekday, 0, 7, true)?,
            either_day: !day.starts_with('*') && !weekday.starts_with('*'),
        })
    }

    fn matches(&self, at: &chrono::DateTime<Local>) -> bool {
        let day = self.days.contains(&at.day());
        let weekday = self.weekdays.contains(&at.weekday().num_days_from_sunday());
        let day_matches = if self.either_day {
            day || weekday
        } else {
            day && weekday
        };
        day_matches
            && self.minutes.contains(&at.minute())
            && self.hours.contains(&at.hour())
            && self.months.contains(&at.month())
    }
}

/// The first minute after `after` (epoch milliseconds) that `expression`
/// names, in local time. `None` for an invalid expression, an empty one (a
/// task switched off), or one that names no real date (`0 0 31 2 *`).
pub fn next_due(expression: &str, after: i64) -> Option<i64> {
    if expression.trim().is_empty() {
        return None;
    }
    let cron = Cron::parse(expression)?;
    // A date no month has (`0 0 31 2 *`) would otherwise search four years
    // of minutes before giving up.
    const LONGEST: [u32; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !cron.either_day
        && !cron.months.iter().any(|month| {
            cron.days
                .iter()
                .any(|day| *day <= LONGEST[*month as usize - 1])
        })
    {
        return None;
    }
    let mut cursor = after
        .div_euclid(MINUTE)
        .checked_mul(MINUTE)?
        .checked_add(MINUTE)?;
    let end = after.saturating_add(SEARCH);
    while cursor <= end {
        let at = Local.timestamp_millis_opt(cursor).single()?;
        if cron.matches(&at) {
            return Some(cursor);
        }
        cursor += MINUTE;
    }
    None
}

#[cfg(test)]
#[path = "cron_tests.rs"]
mod tests;
