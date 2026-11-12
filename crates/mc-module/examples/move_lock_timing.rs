//! Measure host-writer contention on a disposable store, without timing assertions.
//!
//! Run with `cargo run -p mc-module --locked --example move_lock_timing`.
//! The fixture matches the structural test: 2,000 moving rows and 20,000
//! unrelated search rows. Idle samples bracket the complete move, including
//! view/state construction, source validation and the final move fence.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::rules::ProviderRules;
use cortexkit_role_compaction::setup::ModelRef;
use mc_module::context_db::ContextDb;
use mc_module::move_in::{move_in, MoveRequest};
use mc_module::move_renumber::{HostMessage, Numbering};
use mc_module::store::Store;
use std::time::{Duration, Instant};

#[path = "../src/move_in/fixture.rs"]
mod fixture;
#[path = "move_lock_timing/writer.rs"]
mod writer;

fn main() -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = dir.path().join("context.db");
    let (db, _) = fixture::fixture(&path, 2_000, 20_000);
    let writer = writer::Writer::start(&path);
    std::thread::sleep(Duration::from_millis(150));
    writer.phase("move");
    let started = Instant::now();
    let result = move_in(
        db,
        &Store::open(&dir.path().join("mode3.db"))?,
        &mc_module::pass::Settings::default().into(),
        &fixture::request(2_000),
    );
    let moving = started.elapsed();
    eprintln!(
        "MOVE fixture=medium wall={:.3}ms",
        moving.as_secs_f64() * 1000.0
    );
    writer.phase("idle-after");
    std::thread::sleep(moving.max(Duration::from_millis(150)));
    writer::report(writer.finish(), "medium");
    result.map(|_| ())
}
