//! A replay harness for the history line on real sessions, and a measurement
//! of what a fold costs with it.
//!
//! The harness reads summaries from a copy of a store and renders each
//! session's history twice: with the decay curve the released build uses
//! ([`super::render_before_line`]) and with the line. For each it prints how
//! many summaries take each form, the tokens used against the budget, how far
//! back each form reaches, and how many of the summaries scored 85 and 90 or
//! more are visible. It never writes to the store. Run it on the machine that
//! holds the store:
//!
//! ```text
//! MC_LINE_REPLAY_STORE=/path/to/copy/of/context.db \
//! MC_LINE_REPLAY_SESSIONS=ses_a,opencode/ses_b \
//! MC_LINE_REPLAY_BUDGET=98000 \
//! MC_LINE_REPLAY_MODEL=anthropic/claude-opus-5-5 \
//! cargo test --locked -p mc-module --lib line_replay -- --ignored --nocapture
//! ```
//!
//! A session is named by its id, or by `harness/id` when the id is in more
//! than one harness. The budget is the history budget in the provider's
//! tokens (98,000 by default), converted for the model the way a fold does.
//! With `MC_LINE_REPLAY_WRITE=/path/to/file`, the first session's history
//! block as the line renders it is also written to that file. With
//! `MC_LINE_REPLAY_SESSIONS_DB=/path/to/copy/of/sessions.db`, the days in
//! headings also come from the message times ck-mc saved there, as a fold
//! finds them; without it, only the message search index in `context.db` is
//! read. Both files are opened read-only.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use super::head::fit_history;
use super::render::{history_local_budget, render_history, DecayRenderCompartment};
use super::render_before_line;
use crate::context_db::{ContextDb, StoredCompartment};
use crate::count::Counter;

const DEFAULT_BUDGET: f64 = 98_000.0;
const DEFAULT_MODEL: &str = "anthropic/claude-opus-5-5";

/// One renderer's history block for one session.
struct Rendered {
    block: String,
    /// `(summary index, tier, tokens)` of each shown summary.
    items: Vec<(usize, u8, u64)>,
    stretch: Option<f64>,
}

/// Render `rows` as a fold does, with the line or with the curve.
fn fold_history(
    rows: &[DecayRenderCompartment],
    budget: f64,
    counter: Counter,
    line: bool,
) -> Rendered {
    let estimate = |text: &str| counter.count(text) as usize;
    let last = std::cell::RefCell::new((Vec::new(), None));
    let block = fit_history(
        budget,
        |budget| {
            if line {
                let rendered = render_history(rows, budget, estimate);
                *last.borrow_mut() = (rendered.items, rendered.plan.stretch);
                rendered.text
            } else {
                let (text, items) = render_before_line::render(rows, budget, estimate);
                *last.borrow_mut() = (items, None);
                text
            }
        },
        estimate,
    );
    let (items, stretch) = last.into_inner();
    Rendered {
        block,
        items,
        stretch,
    }
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` date.
fn day_number(date: &str) -> Option<i64> {
    let mut parts = date.get(..10)?.split('-');
    let (year, month, day): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    Some(era * 146_097 + of_era_days - 719_468)
}

/// One report line for one renderer.
fn describe(
    name: &str,
    rows: &[DecayRenderCompartment],
    rendered: &Rendered,
    budget: f64,
    counter: Counter,
) -> String {
    let content: Vec<usize> = (0..rows.len())
        .filter(|&i| !rows[i].is_no_content())
        .collect();
    let mut tiers = vec![6u8; rows.len()];
    for &(index, tier, _) in &rendered.items {
        tiers[index] = tier;
    }
    let mut counts = [0usize; 6];
    for &i in &content {
        counts[usize::from(tiers[i] - 1)] += 1;
    }
    let newest = content
        .iter()
        .rev()
        .find_map(|&i| rows[i].end_date.as_deref().and_then(day_number));
    let reach: Vec<String> = (1..=5u8)
        .map(|form| {
            let oldest = content.iter().find(|&&i| tiers[i] <= form);
            match (oldest, newest) {
                (Some(&i), Some(newest)) => rows[i]
                    .start_date
                    .as_deref()
                    .and_then(day_number)
                    .map_or("?".into(), |day| (newest - day).to_string()),
                (Some(_), None) => "?".into(),
                (None, _) => "-".into(),
            }
        })
        .collect();
    let visible = |bar: i32| {
        let scored: Vec<usize> = content
            .iter()
            .copied()
            .filter(|&i| rows[i].importance.unwrap_or(50) >= bar)
            .collect();
        let shown = scored.iter().filter(|&&i| tiers[i] < 6).count();
        format!("{shown}/{}", scored.len())
    };
    let pieces: u64 = rendered.items.iter().map(|item| item.2).sum();
    format!(
        "  {name:<6} | {:>5} {:>7} {:>9} {:>8} {:>5} {:>9} | {:>7} / {:.0} block, {} pieces | {:>4} {:>4} {:>4} {:>4} {:>4} | {:>9} {:>9} | {}",
        counts[0],
        counts[1],
        counts[2],
        counts[3],
        counts[4],
        counts[5],
        counter.count(&rendered.block),
        budget,
        pieces,
        reach[0],
        reach[1],
        reach[2],
        reach[3],
        reach[4],
        visible(85),
        visible(90),
        rendered
            .stretch
            .map_or("-".to_owned(), |stretch| format!("{stretch:.6}")),
    )
}

/// The summaries of each named session, read from the store at `store`
/// without changing it, with the days their headings show. A fold finds a
/// message's time in the session's transcript, then in the times the session
/// saved for the apps (`sessions.db`, when `sessions_db` names a copy of it),
/// then in the message search index (`context.db`); the transcript is not
/// here, so a day is looked up in the other two.
fn read_sessions(
    store: &Path,
    sessions_db: Option<&Path>,
    sessions: &[String],
) -> Result<Vec<(String, Vec<StoredCompartment>)>, String> {
    let open = |path: &Path| {
        Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("opening {}: {error}", path.display()))
    };
    let conn = open(store)?;
    let saved = sessions_db.map(open).transpose()?;
    sessions
        .iter()
        .map(|name| {
            let (harness, session) = match name.split_once('/') {
                Some((harness, session)) => (harness.to_owned(), session.to_owned()),
                None => {
                    let mut harnesses = conn
                        .prepare("SELECT DISTINCT harness FROM compartments WHERE session_id = ?1")
                        .and_then(|mut statement| {
                            statement
                                .query_map([name], |row| row.get::<_, String>(0))?
                                .collect::<Result<Vec<_>, _>>()
                        })
                        .map_err(|error| error.to_string())?;
                    match harnesses.len() {
                        1 => (harnesses.remove(0), name.clone()),
                        0 => return Err(format!("{name}: no summaries in the store")),
                        _ => {
                            return Err(format!("{name}: in {harnesses:?}; name it as harness/id"))
                        }
                    }
                }
            };
            let mut summaries = ContextDb::read_compartments(&conn, &harness, &session)?;
            date(&mut summaries, &conn, saved.as_ref(), &harness, &session)?;
            Ok((format!("{harness}/{session}"), summaries))
        })
        .collect()
}

/// Fill in each summary's days, as a fold does without a transcript.
fn date(
    rows: &mut [StoredCompartment],
    conn: &Connection,
    saved: Option<&Connection>,
    harness: &str,
    session: &str,
) -> Result<(), String> {
    let mut times: HashMap<String, u64> = HashMap::new();
    if let Some(saved) = saved {
        let mut statement = saved
            .prepare(
                "SELECT message_id, at_ms FROM app_read_message_index
                  WHERE harness = ?1 AND session = ?2 AND at_ms > 0",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([harness, session], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (mid, at) = row.map_err(|error| error.to_string())?;
            times.insert(mid, at);
        }
    }
    let unsaved: Vec<(i64, &str)> = rows
        .iter()
        .flat_map(|row| {
            [
                (row.start_message, row.start_message_id.as_str()),
                (row.end_message, row.end_message_id.as_str()),
            ]
        })
        .filter(|(_, mid)| !times.contains_key(*mid))
        .collect();
    let searched = crate::summary::dates::search_times(conn, harness, session, &unsaved);
    let day = |number: i64, mid: &str| {
        times
            .get(mid)
            .copied()
            .or_else(|| searched.get(&(number, mid.to_owned())).copied())
            .and_then(crate::summary::dates::utc_day)
    };
    let days: Vec<_> = rows
        .iter()
        .map(|row| {
            match (
                day(row.start_message, &row.start_message_id),
                day(row.end_message, &row.end_message_id),
            ) {
                (Some(start), Some(end)) => (Some(start), Some(end)),
                _ => (None, None),
            }
        })
        .collect();
    for (row, (start, end)) in rows.iter_mut().zip(days) {
        (row.start_date, row.end_date) = (start, end);
    }
    Ok(())
}

/// The report for `sessions`, and the line's history block of the first one.
fn replay(
    store: &Path,
    sessions_db: Option<&Path>,
    sessions: &[String],
    provider_budget: f64,
    model: &str,
) -> Result<(String, String), String> {
    let counter = Counter::for_model(Some(model));
    let budget = history_local_budget(provider_budget, Some(model));
    let mut report = String::new();
    let mut first_block = None;
    for (name, summaries) in read_sessions(store, sessions_db, sessions)? {
        let rows: Vec<DecayRenderCompartment> =
            summaries.iter().map(DecayRenderCompartment::from).collect();
        let content = rows.iter().filter(|row| !row.is_no_content()).count();
        let dated = rows.iter().filter(|row| row.start_date.is_some()).count();
        report.push_str(&format!(
            "session {name}: {content} summaries with content ({dated} dated), history budget {provider_budget:.0} provider tokens = {budget:.0} counted ({model})\n"
        ));
        report.push_str("  render | full lighter condensed one-line title not-shown | tokens used | days back: full lighter condensed line title | 85+ shown 90+ shown | stretch\n");
        let today = fold_history(&rows, budget, counter, false);
        let line = fold_history(&rows, budget, counter, true);
        report.push_str(&describe("today", &rows, &today, budget, counter));
        report.push('\n');
        report.push_str(&describe("line", &rows, &line, budget, counter));
        report.push('\n');
        first_block.get_or_insert(line.block);
    }
    Ok((report, first_block.unwrap_or_default()))
}

/// Run on request on a copy of a real store; see the module docs.
#[test]
#[ignore = "reads a real store named by MC_LINE_REPLAY_STORE; run by hand with --ignored --nocapture"]
fn line_replay() {
    let store = std::env::var("MC_LINE_REPLAY_STORE").expect("MC_LINE_REPLAY_STORE");
    let sessions: Vec<String> = std::env::var("MC_LINE_REPLAY_SESSIONS")
        .expect("MC_LINE_REPLAY_SESSIONS")
        .split(',')
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    let budget = std::env::var("MC_LINE_REPLAY_BUDGET")
        .ok()
        .map_or(DEFAULT_BUDGET, |budget| budget.parse().expect("a number"));
    let model = std::env::var("MC_LINE_REPLAY_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
    let sessions_db = std::env::var("MC_LINE_REPLAY_SESSIONS_DB").ok();
    let (report, block) = replay(
        Path::new(&store),
        sessions_db.as_deref().map(Path::new),
        &sessions,
        budget,
        &model,
    )
    .unwrap();
    println!("{report}");
    if let Ok(path) = std::env::var("MC_LINE_REPLAY_WRITE") {
        std::fs::write(&path, block).unwrap();
        println!(
            "wrote the line's history block of {} to {path}",
            sessions[0]
        );
    }
}

/// A generated store with summaries for each of `sessions`, and a sessions
/// store that saved the times of the first one's messages.
fn generated_store(
    dir: &Path,
    sessions: &[(&str, usize)],
) -> (std::path::PathBuf, std::path::PathBuf) {
    let path = dir.join("context.db");
    let db = ContextDb::create_for_tests(&path).unwrap();
    db.with_connection(|conn| {
        for &(session, count) in sessions {
            for sequence in 1..=count as i64 {
                let start = sequence * 10;
                let body = |n: usize| "Read the reader and kept its diagnostics stable. ".repeat(n);
                conn.execute(
                    "INSERT INTO compartments (session_id, harness, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, created_at)
                     VALUES (?1, 'opencode', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?11, ?12, ?2)",
                    rusqlite::params![
                        session,
                        sequence,
                        start,
                        start + 9,
                        format!("m{start}"),
                        format!("m{}", start + 9),
                        format!("Work {sequence}"),
                        body(8 + sequence as usize % 20),
                        body(3 + sequence as usize % 4),
                        body(1 + sequence as usize % 2),
                        body(1),
                        20 + sequence * 37 % 80,
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        Ok::<_, String>(())
    })
    .unwrap();
    drop(db);
    let saved = dir.join("sessions.db");
    drop(crate::store::Store::open(&saved).unwrap());
    let conn = Connection::open(&saved).unwrap();
    let (session, count) = sessions[0];
    for message in 1..=(count as i64 * 10 + 9) {
        // About eleven summaries a day.
        conn.execute(
            "INSERT INTO app_read_message_index (runner, harness, session, message_id, ordinal, at_ms) VALUES ('r', 'opencode', ?1, ?2, ?3, ?4)",
            rusqlite::params![session, format!("m{message}"), message, 1_767_225_600_000 + message * 785_454],
        )
        .unwrap();
    }
    (path, saved)
}

#[test]
fn the_line_replay_reports_both_renderers_on_a_generated_store() {
    let dir = tempfile::tempdir().unwrap();
    let (store, saved) = generated_store(dir.path(), &[("ses_large", 1_200), ("ses_small", 40)]);
    let before = (
        std::fs::read(&store).unwrap(),
        std::fs::read(&saved).unwrap(),
    );
    let (report, block) = replay(
        &store,
        Some(&saved),
        &["ses_large".into(), "opencode/ses_small".into()],
        20_000.0,
        DEFAULT_MODEL,
    )
    .unwrap();
    println!("{report}");
    assert!(report.contains("session opencode/ses_large: 1200 summaries with content (1200 dated)"));
    assert!(report.contains("session opencode/ses_small: 40 summaries with content (0 dated)"));
    assert_eq!(report.matches("  today  | ").count(), 2);
    assert_eq!(report.matches("  line   | ").count(), 2);
    assert!(block.starts_with("<session-history>\n## "));
    assert!(block.ends_with("\n</session-history>"));
    // Titles of one day share a heading.
    assert!(block.contains(" summaries\n- "));
    // The stores are only read.
    assert_eq!(
        (
            std::fs::read(&store).unwrap(),
            std::fs::read(&saved).unwrap()
        ),
        before
    );
    assert!(replay(&store, None, &["missing".into()], 20_000.0, DEFAULT_MODEL).is_err());
}

/// Summaries shaped like a real session's: the sizes of the forms in the
/// session `testdata/history-line-shape.json` describes (about 250, 120, 55, 45 and 25 tokens), prose from a varied
/// vocabulary, about 25 a day, and scores mostly between 15 and 89.
fn realistic(count: usize, seed: u64) -> Vec<StoredCompartment> {
    realistic_in(count, seed, &LATIN)
}

const LATIN: [&str; 24] = [
    "the",
    "reader",
    "parser",
    "kept",
    "diagnostics",
    "stable",
    "while",
    "summary_due",
    "crates/mc-module/src/session.rs",
    "traced",
    "notice",
    "through",
    "regression",
    "test",
    "cargo",
    "fold",
    "baseline",
    "budget",
    "cache",
    "prefix",
    "rebuild",
    "memory",
    "and",
    "of",
];

/// Chinese, Japanese and Russian prose with a few code names, where a token
/// holds far fewer characters than in English.
const NON_LATIN: [&str; 24] = [
    "解析器",
    "读取了文件",
    "并保持诊断稳定",
    "缓存前缀",
    "重建",
    "の設定を確認した",
    "テストを追加",
    "メモリ",
    "сводка",
    "проверили",
    "кэш",
    "перестроение",
    "бюджет",
    "summary_due",
    "session.rs",
    "历史记录",
    "折叠",
    "基线",
    "ストア",
    "сообщение",
    "和",
    "の",
    "и",
    "在",
];

fn realistic_in(count: usize, seed: u64, vocabulary: &[&str; 24]) -> Vec<StoredCompartment> {
    let mut random = super::line_tests::Random::new(seed);
    let text = |random: &mut super::line_tests::Random, tokens: u64| {
        let words = random.between(tokens * 6 / 10, tokens * 14 / 10);
        (0..words)
            .map(|_| vocabulary[random.between(0, 23) as usize])
            .collect::<Vec<_>>()
            .join(" ")
    };
    (0..count as i64)
        .map(|sequence| {
            let start = sequence * 12 + 1;
            let day = sequence / 25;
            let date = format!("2026-{:02}-{:02}", 1 + day / 28 % 12, 1 + day % 28);
            let full = text(&mut random, 250);
            StoredCompartment {
                sequence,
                start_message: start,
                end_message: start + 11,
                start_message_id: format!("m{start}"),
                end_message_id: format!("m{}", start + 11),
                start_date: Some(date.clone()),
                end_date: Some(date),
                title: text(&mut random, 18),
                content: full.as_str().into(),
                p1: Some(full.as_str().into()),
                p2: Some(text(&mut random, 115)),
                p3: Some(text(&mut random, 50)),
                p4: Some(text(&mut random, 40)),
                importance: if random.between(1, 100) <= 8 {
                    random.between(90, 100) as i32
                } else {
                    random.between(15, 89) as i32
                },
                ..Default::default()
            }
        })
        .collect()
}

/// Stored summaries from rendered rows, numbered from 0, for a fold.
fn stored(rows: &[DecayRenderCompartment]) -> Vec<StoredCompartment> {
    rows.iter()
        .zip(0..)
        .map(|(row, sequence)| StoredCompartment {
            sequence,
            start_message: row.start_message,
            end_message: row.end_message,
            start_message_id: format!("m{}", row.start_message),
            end_message_id: format!("m{}", row.end_message),
            start_date: row.start_date.clone(),
            end_date: row.end_date.clone(),
            title: row.title.clone(),
            content: row.content.as_str().into(),
            p1: row.p1.as_deref().map(Into::into),
            p2: row.p2.clone(),
            p3: row.p3.clone(),
            p4: row.p4.clone(),
            importance: row.importance.unwrap_or(50),
            ..Default::default()
        })
        .collect()
}

/// What a fold costs on 3,800 summaries, with the exact Claude counter and
/// with the estimator: the first fold of a session after a start, which
/// counts every piece the search looks at, and a later fold, which finds
/// those counts kept; against the curve's history render. Also how large
/// history gets with no budget, and how much budget the widest line leaves
/// unused just past the point where everything fits in full.
#[test]
#[ignore = "a measurement; run with --release --ignored --nocapture"]
fn line_fold_time() {
    use super::render::HistoryCounts;
    let classes = HashMap::new();
    let best_of_3 = |run: &mut dyn FnMut() -> f64| (0..3).map(|_| run()).fold(f64::MAX, f64::min);
    let timed = |run: &mut dyn FnMut()| {
        let started = std::time::Instant::now();
        run();
        started.elapsed().as_secs_f64() * 1000.0
    };
    for (name, counter) in [
        ("exact Claude", Counter::for_model(Some(DEFAULT_MODEL))),
        (
            "estimator",
            Counter::estimated_for_model(Some(DEFAULT_MODEL)),
        ),
    ] {
        let fold = |summaries: &[StoredCompartment], budget: u64, counts: &HistoryCounts| {
            let inputs = super::head::Inputs {
                counter,
                summaries,
                docs: "",
                rows: &[],
                classes: &classes,
                now_ms: 0,
                gone: &[],
                history_budget_tokens: budget,
                history_local_budget_tokens: budget,
                memory_budget_tokens: 0,
                profile_budget_tokens: 0,
            };
            super::head::fold_with_counts(&inputs, &Default::default(), None, counts)
        };
        for script in ["latin", "cjk", "newest 400 cjk", "sample rows latin"] {
            let rows = super::render_line_tests::scripted_session(script, 3_800, 1127);
            let summaries = stored(&rows);
            for budget in [30_000u64, 98_000] {
                let first = best_of_3(&mut || {
                    let counts = HistoryCounts::default();
                    timed(&mut || {
                        fold(&summaries, budget, &counts);
                    })
                });
                let counts = HistoryCounts::default();
                let cold = fold(&summaries, budget, &counts);
                let warm = best_of_3(&mut || {
                    timed(&mut || {
                        let again = fold(&summaries, budget, &counts);
                        assert_eq!(again.m0, cold.m0);
                    })
                });
                let curve = best_of_3(&mut || {
                    timed(&mut || {
                        fold_history(&rows, budget as f64, counter, false);
                    })
                });
                println!(
                    "FOLD_TIME {name}, {script}, 3800 at {budget}: first fold {first:.0} ms, later fold {warm:.0} ms; the curve's history alone {curve:.0} ms"
                );
            }
        }
        for count in [500, 3_800] {
            let summaries = stored(&super::render_line_tests::scripted_session(
                "latin", count, 1127,
            ));
            for budget in [30_000u64, 98_000] {
                let first = best_of_3(&mut || {
                    let counts = HistoryCounts::default();
                    timed(&mut || {
                        fold(&summaries, budget, &counts);
                    })
                });
                println!("FIRST_FOLD {name}, latin, {count} at {budget}: {first:.0} ms");
            }
        }
    }

    let counter = Counter::for_model(Some(DEFAULT_MODEL));
    let estimate = |text: &str| counter.count(text) as usize;
    for count in [3_800, 1_000, 200] {
        let rows: Vec<DecayRenderCompartment> = realistic(count, 7)
            .iter()
            .map(DecayRenderCompartment::from)
            .collect();
        let (today, _) = render_before_line::render(&rows, 0.0, estimate);
        let line = fold_history(&rows, 0.0, counter, true);
        println!(
            "NO_BUDGET {count} summaries: the curve renders {} tokens, the line {} tokens",
            counter.count(&format!("<session-history>\n{today}\n</session-history>")),
            counter.count(&line.block)
        );
    }

    for count in [50, 300, 1_200] {
        let rows: Vec<DecayRenderCompartment> = realistic(count, 9)
            .iter()
            .map(DecayRenderCompartment::from)
            .collect();
        let full = render_history(&rows, f64::MAX, estimate).plan.total;
        for short in [1u64, full / 100, full / 20] {
            let budget = (full - short) as f64;
            let plan = render_history(&rows, budget, estimate).plan;
            println!(
                "PAST_FULL {count} summaries, budget {budget:.0} ({short} short of all in full): {} used, {:.0} unused, stretch {:?}",
                plan.total,
                budget - plan.total as f64,
                plan.stretch
            );
        }
    }
}

/// The six budgets `testdata/history-line-shape.json` holds expected results for.
const LAB_BUDGETS: [f64; 6] = [5_000.0, 15_000.0, 30_000.0, 60_000.0, 98_000.0, 150_000.0];

/// How many texts a fold counts and how many characters they hold, with
/// the curve or with the line.
fn counting(
    rows: &[DecayRenderCompartment],
    budget: f64,
    counter: Counter,
    line: bool,
) -> (usize, usize) {
    let calls = std::cell::Cell::new((0usize, 0usize));
    let estimate = |text: &str| {
        let (n, chars) = calls.get();
        calls.set((n + 1, chars + text.chars().count()));
        counter.count(text) as usize
    };
    fit_history(
        budget,
        |budget| {
            if line {
                render_history(rows, budget, estimate).text
            } else {
                render_before_line::render(rows, budget, estimate).0
            }
        },
        estimate,
    );
    calls.get()
}

/// On long Chinese, Japanese and Russian text, where a token holds the
/// fewest characters, each of those six budgets ends within it, with either
/// counter.
#[test]
fn the_search_ends_within_the_budget_on_non_latin_text() {
    let rows: Vec<DecayRenderCompartment> = realistic_in(1_200, 3, &NON_LATIN)
        .iter()
        .map(DecayRenderCompartment::from)
        .collect();
    for counter in [
        Counter::for_model(Some(DEFAULT_MODEL)),
        Counter::estimated_for_model(Some(DEFAULT_MODEL)),
    ] {
        let estimate = |text: &str| counter.count(text) as usize;
        for budget in LAB_BUDGETS {
            let rendered = render_history(&rows, budget, estimate);
            assert!(
                rendered.plan.total as f64 <= budget,
                "{} at {budget}",
                rendered.plan.total
            );
            let counted: u64 = rendered.items.iter().map(|item| item.2).sum();
            assert_eq!(counted + rendered.plan.joints, rendered.plan.total);
            // The joined body, blank lines included, is within the budget too.
            assert!(counter.count(&rendered.text) as f64 <= budget);
            assert_eq!(
                *rendered.body_tokens.last().unwrap(),
                counter.count(&rendered.text)
            );
        }
    }
}

/// Two folds of the same stored summaries give the same bytes and the same
/// attribution, each with its own counter and its own read of the store.
#[test]
fn two_folds_of_the_same_store_give_the_same_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (store, saved) = generated_store(dir.path(), &[("ses_large", 1_200)]);
    let fold = || {
        let (_, summaries) = read_sessions(&store, Some(&saved), &["ses_large".into()])
            .unwrap()
            .remove(0);
        let classes = HashMap::new();
        let inputs = super::head::Inputs {
            counter: Counter::for_model(Some(DEFAULT_MODEL)),
            summaries: &summaries,
            docs: "",
            rows: &[],
            classes: &classes,
            now_ms: 0,
            gone: &[],
            history_budget_tokens: 30_000,
            history_local_budget_tokens: 30_000,
            memory_budget_tokens: 0,
            profile_budget_tokens: 0,
        };
        super::head::fold_with(&inputs, &Default::default(), None)
    };
    let (first, second) = (fold(), fold());
    assert!(first.m0.contains(" summaries\n- "));
    assert_eq!(first.m0, second.m0);
    assert_eq!(first.summary_items, second.summary_items);
}

/// How much of each of those six budgets a fold uses, on the realistic
/// session and on long non-Latin text: the pieces' total, the joined body
/// and the wrapped block against the budget.
#[test]
#[ignore = "a measurement; run with --release --ignored --nocapture"]
fn line_budget_use() {
    for (text, vocabulary) in [("Latin", &LATIN), ("non-Latin", &NON_LATIN)] {
        let rows: Vec<DecayRenderCompartment> = realistic_in(3_800, 1127, vocabulary)
            .iter()
            .map(DecayRenderCompartment::from)
            .collect();
        for (name, counter) in [
            ("exact Claude", Counter::for_model(Some(DEFAULT_MODEL))),
            (
                "estimator",
                Counter::estimated_for_model(Some(DEFAULT_MODEL)),
            ),
        ] {
            let estimate = |text: &str| counter.count(text) as usize;
            for budget in LAB_BUDGETS {
                let rendered = render_history(&rows, budget, estimate);
                let plan = &rendered.plan;
                let block = fold_history(&rows, budget, counter, true).block;
                println!(
                    "BUDGET_USE {text} {name} at {budget:.0}: pieces {:+}; body first {:+}, final {:+} after {} replans; wrapped block {:+}",
                    plan.total as i64 - plan.budget as i64,
                    rendered.body_tokens[0] as i64 - budget as i64,
                    *rendered.body_tokens.last().unwrap() as i64 - budget as i64,
                    rendered.body_tokens.len() - 1,
                    counter.count(&block) as i64 - budget as i64,
                );
            }
            let (curve_calls, curve_chars) = counting(&rows, 98_000.0, counter, false);
            let (line_calls, line_chars) = counting(&rows, 98_000.0, counter, true);
            println!(
                "COUNTED {text} {name} at 98000: the curve counts {curve_calls} texts of {curve_chars} characters, the line {line_calls} texts of {line_chars} characters"
            );
        }
    }
}
