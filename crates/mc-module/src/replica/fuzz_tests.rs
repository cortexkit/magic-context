//! Random interleavings of edits, dreamer writes, sends, reads, restarts,
//! deletes, same-fact creates and streams made anew on three computers,
//! checked for convergence: once every computer has sent and read all it
//! can, every global id has the same text, importance and status on each.
//!
//! A few fixed seeds run with the rest of the tests; the long runs are
//! ignored, to be run by hand (`--ignored`, with `FUZZ_SEEDS` and
//! `FUZZ_STEPS` to size them and `FUZZ_ONLY` to run one seed).

use super::hub::InMemoryHub;
use super::test_support::{memory, Computer};

/// A small xorshift generator, so a seed always gives the same run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Which kinds of step a run takes besides edits, sightings, dreamer
/// writes, sends, reads, restarts and lost or refused sends.
#[derive(Clone, Copy, Debug)]
struct Steps {
    /// The person deletes a memory.
    deletes: bool,
    /// A computer writes a memory whose fact another may hold already.
    facts: bool,
    /// The hub's stream is made anew under every computer.
    resets: bool,
}

const ROLE: &str = "dreamer.pj-a";

fn dreamer_writes(computer: &Computer, generation: i64, sql: &str) {
    computer.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        super::name_writer(&tx, "dreamer", Some(1), &[(ROLE.to_owned(), generation)]).unwrap();
        tx.execute_batch(sql).unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
    });
}

/// Every replicated memory's global id, text, importance and status.
fn rows(computer: &Computer) -> Vec<String> {
    computer.texts(
        "SELECT COALESCE(global_id, '-') || ' ' || content || ' ' || COALESCE(importance, -1)
                || ' ' || COALESCE(status, '-')
           FROM memories WHERE level <> 'agent' ORDER BY global_id",
    )
}

/// What a diverged run's computers hold, to find the cause.
fn detail(computers: &[Computer], hub: &InMemoryHub) -> String {
    let mut detail = String::new();
    for (index, computer) in computers.iter().enumerate() {
        detail.push_str(&format!(
            "\nc{} pos {} store {}\n  outbox {:?}\n  ids {:?}\n  passed {:?} restore {:?} rejects {:?}\n  local {:?}",
            index + 1,
            computer.replica.position().unwrap(),
            computer.store_id(),
            computer.texts(
                "SELECT id || ' ' || kind || ':' || local_id || ' ' || change || ' r' || revision
                        || ' ' || state || ' ' || COALESCE(sender, '-')
                        || ' seq' || COALESCE(stream_seq, '-') || ' ' || actor
                        || ' e' || COALESCE(epoch, '-')
                        || ' f' || CASE WHEN frozen IS NULL THEN 0 ELSE 1 END
                   FROM replica_outbox ORDER BY id"
            ),
            computer.texts(
                "SELECT global_id || ' l' || COALESCE(local_id, '-')
                        || ' del' || COALESCE(deleted_at IS NOT NULL, 0)
                        || ' r' || COALESCE(revision, '-') || ' seq' || COALESCE(seq, '-')
                        || ' w' || COALESCE(written, '-') || ' u' || COALESCE(undone, '-')
                        || ' ' || COALESCE(subject, '-')
                   FROM replica_ids ORDER BY global_id"
            ),
            computer.texts("SELECT global_id || ' seq' || seq || ' r' || revision FROM replica_passed"),
            computer.texts("SELECT global_id || ' seq' || seq FROM replica_restore"),
            computer.texts("SELECT stream_seq || ' ' || reason FROM replica_rejects"),
            computer.texts(
                "SELECT m.id || ' ' || COALESCE(m.global_id, '-') || ' r' || m.revision || ' '
                        || m.content || ' ' || COALESCE(m.status, '-')
                        || ' sup' || COALESCE(m.superseded_by_memory_id, '-')
                        || ' derived[' || COALESCE((SELECT 'surv' || COALESCE(d.survivor, '-')
                                                           || ' own ' || COALESCE(d.status, '-')
                                                      FROM replica_derived d WHERE d.local_id = m.id), '')
                        || ']'
                   FROM memories m ORDER BY m.id"
            ),
        ));
    }
    let messages: Vec<String> = hub
        .messages()
        .iter()
        .map(|message| {
            format!(
                "{} {}",
                message.seq,
                message.message_id.clone().unwrap_or_default()
            )
        })
        .collect();
    detail.push_str(&format!("\nstream {messages:?}"));
    detail
}

/// Every computer sends and reads until nothing is left to do.
async fn settle(computers: &[Computer]) {
    for _ in 0..6 {
        for computer in computers {
            for _ in 0..4 {
                match computer.replica.publish().await {
                    Ok(report) if report.sent == 0 => break,
                    _ => {}
                }
            }
            for _ in 0..50 {
                if computer.replica.join().await.is_err() {
                    continue;
                }
                if let Ok(0) = computer.replica.follow().await {
                    break;
                }
            }
        }
    }
}

/// One run of `steps` random steps under `seed`; an error describes how
/// the computers diverged.
async fn run(seed: u64, steps: usize, kinds: Steps) -> Result<(), String> {
    let mut hub = InMemoryHub::new();
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut computers: Vec<Computer> = (1..=3).map(|n| Computer::new(&hub, n)).collect();
    memory(&computers[0], "pj-a", "Row one.");
    memory(&computers[0], "pj-a", "Row two.");
    for computer in &computers {
        computer.sync().await;
    }
    for computer in &computers {
        computer.follow_all().await;
    }
    let mut fleet_generation: i64 = 1;
    let mut generations = [1i64, 1, 1];
    let mut log = Vec::new();
    for step in 0..steps {
        let k = rng.below(3) as usize;
        let action = rng.below(11 + u64::from(kinds.deletes) + u64::from(kinds.resets));
        if kinds.facts && rng.below(6) == 0 {
            let text = ["Fact A.", "Fact B.", "Row one."][rng.below(3) as usize];
            log.push(format!("{step}: c{} creates {text}", k + 1));
            computers[k].db.with_connection(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO memories (level, owner_id, category, origin_category,
                         content, normalized_hash, first_seen_at, created_at, updated_at,
                         last_seen_at)
                     VALUES ('project', 'pj-a', 'swe:architecture', 'ARCHITECTURE', ?1, ?2,
                             1, 1, 1, 1)",
                    rusqlite::params![text, crate::memory_writes::normalized_hash(text)],
                )
                .unwrap();
            });
            continue;
        }
        // The last action is the stream made anew, when the run has it.
        if kinds.resets && action == 10 + u64::from(kinds.deletes) + 1 {
            log.push(format!("{step}: stream made anew"));
            hub = InMemoryHub::new();
            for (index, computer) in computers.iter_mut().enumerate() {
                let copy = computer.copy();
                *computer = Computer::open(&hub, (index + 1) as u8, copy);
            }
            continue;
        }
        let row = if rng.below(2) == 0 { "MIN" } else { "MAX" };
        let target = format!("(SELECT {row}(id) FROM memories)");
        log.push(format!("{step}: c{} a{action} {row}", k + 1));
        let c = &computers[k];
        match action {
            0 => c.execute(&format!(
                "UPDATE memories SET content = 'text {step} by {k}' WHERE id = {target}"
            )),
            1 => c.execute(&format!(
                "UPDATE memories SET importance = {step} WHERE id = {target}"
            )),
            2 => c.execute(&format!(
                "UPDATE memories SET revision = revision + 1 WHERE id = {target}"
            )),
            3 => dreamer_writes(
                c,
                generations[k],
                &format!(
                    "UPDATE memories SET importance = {} WHERE id = {target}",
                    1000 + step
                ),
            ),
            4 => {
                fleet_generation += 1;
                generations[k] = fleet_generation;
            }
            5 | 6 => {
                let _ = c.replica.publish().await;
            }
            7 | 8 => {
                if c.replica.join().await.is_ok() {
                    let _ = c.replica.follow().await;
                }
            }
            9 => {
                let copy = c.copy();
                computers[k] = Computer::open(&hub, (k + 1) as u8, copy);
            }
            10 => {
                if rng.below(2) == 0 {
                    hub.lose_next_acks(1);
                } else {
                    hub.refuse_next(1);
                }
            }
            _ => {
                let id: Option<i64> = c
                    .db
                    .with_connection(|conn| {
                        conn.query_row(&format!("SELECT {row}(id) FROM memories"), [], |r| {
                            r.get(0)
                        })
                    })
                    .unwrap();
                if let Some(id) = id {
                    c.db.with_connection(|conn| {
                        let tx = conn.transaction().unwrap();
                        crate::memory_writes::person::purge(&tx, id).unwrap();
                        tx.commit().unwrap();
                    });
                }
            }
        }
    }
    hub.lose_next_acks(0);
    hub.refuse_next(0);
    settle(&computers).await;
    let first = rows(&computers[0]);
    for (index, computer) in computers.iter().enumerate().skip(1) {
        let other = rows(computer);
        if other != first {
            return Err(format!(
                "seed {seed} ({kinds:?}): c1 {first:?} vs c{} {other:?}\n{}{}",
                index + 1,
                log.join("\n"),
                detail(&computers, &hub)
            ));
        }
    }
    Ok(())
}

/// Run `seeds` under `kinds`, and fail with the first few that diverged.
async fn converge(seeds: std::ops::RangeInclusive<u64>, steps: usize, kinds: Steps) {
    let only: Option<u64> = std::env::var("FUZZ_ONLY").ok().and_then(|s| s.parse().ok());
    let count = seeds.clone().count();
    let mut failures = Vec::new();
    for seed in seeds {
        if only.is_some_and(|only| only != seed) {
            continue;
        }
        if let Err(error) = run(seed, steps, kinds).await {
            failures.push(error);
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {count} seeds diverged; the first ones:\n{}",
        failures.len(),
        failures
            .iter()
            .take(3)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n\n")
    );
}

const EVERY_STEP: Steps = Steps {
    deletes: true,
    facts: true,
    resets: true,
};

/// A few seeds with every kind of step, fast enough for every test run.
#[tokio::test]
async fn a_few_random_runs_with_every_kind_of_step_converge() {
    converge(1..=12, 40, EVERY_STEP).await;
}

fn sized(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// The long runs: each kind of step on its own, and all of them together,
/// over many seeds.
#[tokio::test]
#[ignore = "long: hundreds of random runs; run with --ignored"]
async fn many_random_runs_converge() {
    let seeds = sized("FUZZ_SEEDS", 400);
    let steps = sized("FUZZ_STEPS", 40) as usize;
    let none = Steps {
        deletes: false,
        facts: false,
        resets: false,
    };
    for kinds in [
        none,
        Steps {
            deletes: true,
            ..none
        },
        Steps {
            resets: true,
            ..none
        },
        Steps {
            deletes: true,
            facts: true,
            ..none
        },
        EVERY_STEP,
    ] {
        converge(1..=seeds, steps, kinds).await;
    }
}
