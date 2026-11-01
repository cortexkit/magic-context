//! Five-field local-civil cron, with real-minute stepping across DST transitions.

use rusqlite::Connection;

const MINUTE: i64 = 60_000;
const SEARCH: i64 = 4 * 366 * 24 * 60 * MINUTE;

struct Cron {
    fields: Vec<Vec<u32>>,
    dom_restricted: bool,
    dow_restricted: bool,
}

fn number(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn field(token: &str, min: u32, max: u32, dow: bool) -> Option<Vec<u32>> {
    let mut values = Vec::new();
    for piece in token.split(',') {
        let parts: Vec<_> = piece.trim().split('/').collect();
        if parts.len() > 2 {
            return None;
        }
        let step = if parts.len() == 2 {
            number(parts[1])?
        } else {
            1
        };
        if step == 0 {
            return None;
        }
        let (lo, hi) = if parts[0] == "*" {
            (min, max)
        } else if let Some((lo, hi)) = parts[0].split_once('-') {
            (number(lo)?, number(hi)?)
        } else {
            let lo = number(parts[0])?;
            (lo, if parts.len() == 2 { max } else { lo })
        };
        if lo < min || hi > max || lo > max || hi < min || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            values.push(if dow && v == 7 { 0 } else { v });
            let Some(next) = v.checked_add(step) else {
                break;
            };
            v = next;
        }
    }
    (!values.is_empty()).then_some(values)
}

fn parse(expression: &str) -> Option<Cron> {
    let tokens: Vec<_> = expression.split_whitespace().collect();
    if tokens.len() != 5 {
        return None;
    }
    let mut fields = Vec::new();
    for (i, (min, max)) in [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
        .iter()
        .enumerate()
    {
        fields.push(field(tokens[i], *min, *max, i == 4)?);
    }
    Some(Cron {
        fields,
        dom_restricted: !tokens[2].starts_with('*'),
        dow_restricted: !tokens[4].starts_with('*'),
    })
}

// SQLite's localtime modifier uses the process timezone, matching JavaScript
// Date in the plugin scheduler. Both schedulers therefore follow the same local
// wall clock without needing a separate timezone setting.
fn civil(db: &Connection, ms: i64) -> rusqlite::Result<[u32; 6]> {
    db.query_row(
        "SELECT strftime('%Y',?1,'unixepoch','localtime'),
                strftime('%m',?1,'unixepoch','localtime'),
                strftime('%d',?1,'unixepoch','localtime'),
                strftime('%H',?1,'unixepoch','localtime'),
                strftime('%M',?1,'unixepoch','localtime'),
                strftime('%w',?1,'unixepoch','localtime')",
        [ms.div_euclid(1000)],
        |row| {
            let mut result = [0; 6];
            for (i, value) in result.iter_mut().enumerate() {
                let s: String = row.get(i)?;
                *value = s.parse().map_err(|_| rusqlite::Error::InvalidQuery)?;
            }
            Ok(result)
        },
    )
}

pub fn next_due(
    expression: &str,
    after: i64,
    consumed: Option<i64>,
) -> rusqlite::Result<Option<i64>> {
    let Some(cron) = parse(expression) else {
        return Ok(None);
    };
    let days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(cron.dom_restricted && cron.dow_restricted)
        && !cron.fields[3]
            .iter()
            .any(|m| cron.fields[2].iter().any(|d| *d <= days[*m as usize - 1]))
    {
        return Ok(None);
    }
    let db = Connection::open_in_memory()?;
    let exclude = consumed.map(|ms| civil(&db, ms)).transpose()?;
    let Some(mut cursor) = after
        .div_euclid(MINUTE)
        .checked_mul(MINUTE)
        .and_then(|v| v.checked_add(MINUTE))
    else {
        return Ok(None);
    };
    let cap = after.saturating_add(SEARCH);
    while cursor <= cap {
        let c = civil(&db, cursor)?;
        let dom = cron.fields[2].contains(&c[2]);
        let dow = cron.fields[4].contains(&c[5]);
        let day = if cron.dom_restricted && cron.dow_restricted {
            dom || dow
        } else {
            dom && dow
        };
        if day
            && cron.fields[0].contains(&c[4])
            && cron.fields[1].contains(&c[3])
            && cron.fields[3].contains(&c[1])
            && exclude.is_none_or(|e| e[..5] != c[..5])
        {
            return Ok(Some(cursor));
        }
        let Some(next) = cursor.checked_add(MINUTE) else {
            break;
        };
        cursor = next;
    }
    Ok(None)
}

pub(super) fn is_repeated(candidate: i64) -> rusqlite::Result<bool> {
    let db = Connection::open_in_memory()?;
    let key = civil(&db, candidate)?;
    // IANA civil offset rollbacks can exceed an hour. Search the preceding day
    // rather than assuming the usual one-hour daylight-saving transition.
    for minutes in 1..=24 * 60 {
        if let Some(prior) = candidate.checked_sub(minutes * MINUTE) {
            if civil(&db, prior)?[..5] == key[..5] {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
