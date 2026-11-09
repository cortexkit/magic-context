//! What newer summaries add to the history head is kept between view builds
//! (`HeadSummaries`). Kept or computed afresh, it must give the same bytes.
//! One session runs, twice, through paths the head-bytes golden does not
//! reach: a summary appended the way a summarizer run appends it, views the
//! runner has not confirmed yet, a refused view rolled back, a model change,
//! a summary with no content, the summaries loaded again unchanged, a revert
//! of a summary `m[0]` shows, and a summary appended after the fold that
//! revert forces. The first run keeps the newer summaries between builds;
//! the second drops them before every build, as the build before the cache
//! computed them. Every view, baseline, app header and saved state must match.

use super::head_bytes_tests::{add_summary, execute, head};
use super::*;

struct Run {
    session: Session,
    settings: Settings,
    store: crate::store::Store,
    dir: std::path::PathBuf,
    kept: bool,
    records: Vec<Value>,
}

impl Run {
    fn new(label: &str, kept: bool) -> Self {
        let dir = scratch(label);
        let store = crate::store::Store::open(&dir.join("mode3.db")).unwrap();
        let (session, settings) = head(&dir);
        Self {
            session,
            settings,
            store,
            dir,
            kept,
            records: Vec::new(),
        }
    }

    /// Build a view and accept it; confirm it as applied when `settle`.
    fn build(&mut self, settle: bool) -> Option<View> {
        if !self.kept {
            forget_kept(&mut self.session);
        }
        let (view, _) = self.session.build(&self.settings, None, false, None);
        if let Some(view) = &view {
            self.session.accept(view.clone());
            if settle {
                self.session.settle_unconfirmed(
                    Some(&AppliedView::new(view.version, view.checksum.clone())),
                    &[],
                );
            }
        }
        view
    }

    /// Append the newest summary `context.db` holds to the session's list,
    /// as a summarizer run that published it does.
    fn append_newest_summary(&mut self) {
        let newest = self
            .session
            .db
            .as_ref()
            .unwrap()
            .compartments("mock", "s1")
            .unwrap()
            .pop()
            .unwrap();
        self.session.summaries.extend([newest]);
        self.session.summary_unshown = true;
    }

    fn baseline(&self) -> Arc<Baseline> {
        self.session.baseline.clone().unwrap()
    }

    fn summary_items(&self) -> Vec<crate::summary::head::SummaryItem> {
        self.baseline().summary_items.to_vec()
    }

    fn record(&mut self, name: &str, view: Option<&View>) {
        let update = self.session.app_update();
        // The apps' breakdown ends with the summary items of the baseline
        // the runner applies: the one before the oldest unconfirmed view.
        let source = self
            .session
            .unconfirmed
            .first()
            .map_or(self.session.baseline.as_ref(), |pending| {
                pending.before.baseline.as_ref()
            });
        let expected: Vec<Value> = source
            .filter(|_| !self.session.tools_only && !self.session.suspended)
            .map(|baseline| {
                baseline
                    .summary_items
                    .iter()
                    .map(|item| {
                        serde_json::json!({
                            "item":"summary", "compartment_id":item.compartment_id,
                            "tier":item.tier, "tokens":item.tokens, "source":"counted"
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let whole = serde_json::to_value(&update.header.breakdown).unwrap();
        let shown: Vec<Value> = whole["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item["item"] == "summary")
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            shown, expected,
            "{name}: the breakdown's summary items are not the baseline's"
        );
        let header = serde_json::to_string(&*update.header).unwrap();
        let checkpoint = checkpoint_header(&update.header);
        assert_eq!(
            checkpoint, header,
            "{name}: the checkpoint header is not the header's serialization"
        );
        self.store
            .save(&self.session.key, &self.session.durable())
            .unwrap();
        let state: String = rusqlite::Connection::open(self.dir.join("mode3.db"))
            .unwrap()
            .query_row("SELECT state FROM sessions WHERE session='s1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        self.records.push(serde_json::json!({
            "state": name,
            "view": view.map(|view| serde_json::to_string(view).unwrap()),
            "baseline": serde_json::to_string(&self.session.baseline).unwrap(),
            "unconfirmed": self.session.unconfirmed.len(),
            "header": header,
            "checkpoint": checkpoint,
            "stored": state,
        }));
    }
}

fn scenario(run: &mut Run) {
    let view = run.build(true);
    run.record("first render", view.as_ref());
    let first = run.baseline();

    // A summarizer run appends its summary; the runner has not confirmed
    // the view that shows it yet.
    add_summary(
        &run.session,
        4,
        "Newer work on the reader: `fn parse_header(input: &[u8]) -> Result<Header, Error>` now rejects CRLF-split headers, UTF-8 BOMs and 0x7f escapes; see src/reader/header.rs:212.",
    );
    run.append_newest_summary();
    let view = run.build(false);
    let refused = view.as_ref().expect("the newer summary is shown").version;
    run.record("appended summary, view unconfirmed", view.as_ref());
    let appended = run.baseline();
    assert_eq!(appended.summary_items.len(), 4);

    // A memory changes with that view still unconfirmed. `m[1]` still shows
    // summary 4: a build that keeps the newer summaries shares the list the
    // last build made; one that computes them afresh makes a new list.
    execute(
        &run.session,
        "UPDATE memories SET content='Run the gate before every delivery, twice.' WHERE id=1;",
    );
    run.session.head_stale = true;
    let view = run.build(false);
    assert!(view.is_some());
    assert_eq!(run.session.unconfirmed.len(), 2);
    assert_eq!(
        shares_summary_items(&run.baseline(), &appended),
        run.kept,
        "kept newer summaries are shared, fresh ones are made again"
    );
    run.record("memory change on an unconfirmed view", view.as_ref());

    // The runner refuses the first unconfirmed view: both roll back, to the
    // baseline the first render left.
    run.session
        .settle_unconfirmed(None, &[(refused, ViewRefusal::BadSince)]);
    assert!(run.session.unconfirmed.is_empty());
    assert!(Arc::ptr_eq(&run.baseline(), &first));
    run.record("refused view rolled back", None);
    // The rollback moved the cut back, so the index is read again from it,
    // as a runner read would.
    if !run.session.index_ready {
        let from = run.session.cut.unwrap_or(1);
        run.session
            .index
            .extend((from..=60).map(|n| text(n, &format!("m{n}"))));
        run.session.index_ready = true;
    }
    let view = run.build(true);
    assert!(view.is_some(), "the rollback left summary 4 to show");
    run.record("rebuilt after the refusal", view.as_ref());
    let before_model = run.summary_items();
    assert_eq!(before_model.len(), 4);
    let m0 = run.session.baseline.as_ref().unwrap().m0.clone();

    // The model changes: the same baseline and summaries, counted with
    // another tokenizer.
    run.session.conditions.model = ModelRef::new("anthropic", "claude-opus-5-5");
    run.session.head_stale = true;
    let view = run.build(true);
    let after_model = run.summary_items();
    assert_eq!(
        run.session.baseline.as_ref().unwrap().m0,
        m0,
        "the model change folded the head"
    );
    // Summary 4 is counted again in the new model's vocabulary. The two
    // vocabularies must count it differently, or a count kept from before
    // the change would go unseen.
    let newer = run
        .session
        .summaries
        .iter()
        .find(|summary| summary.sequence == 4)
        .unwrap();
    let text = crate::summary::render::render_compartment_at_tier(
        &crate::summary::render::DecayRenderCompartment::from(newer),
        1,
    );
    let exact = crate::count::Counter::for_model(Some("anthropic/claude-opus-5-5")).count(&text);
    let estimate = crate::count::Counter::for_model(Some("test/model")).count(&text);
    assert_ne!(exact, estimate, "{text}");
    assert_eq!(before_model.last().unwrap().tokens, estimate);
    assert_eq!(after_model.last().unwrap().tokens, exact);
    run.record("model change", view.as_ref());

    // A summary with no content, then one with content, loaded from
    // context.db.
    execute(
        &run.session,
        "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, importance, created_at, harness)
            VALUES ('s1', 5, 17, 20, 'm17', 'm20', '', '', 50, 5, 'mock');",
    );
    add_summary(&run.session, 6, "Work after an empty summary.");
    run.session.load_summaries();
    run.session.summary_unshown = true;
    let view = run.build(true);
    let ids: Vec<_> = run
        .summary_items()
        .iter()
        .map(|item| item.compartment_id.clone())
        .collect();
    assert_eq!(ids, ["1", "2", "3", "4", "6"]);
    run.record("summary with no content", view.as_ref());

    // The same summaries loaded again.
    run.session.load_summaries();
    run.session.head_stale = true;
    let view = run.build(true);
    run.record("summaries loaded again", view.as_ref());

    // A revert removes a summary `m[0]` shows: the head folds again.
    run.session.forget_summaries_from(9);
    let view = run.build(true);
    assert_eq!(run.session.baseline.as_ref().unwrap().through_sequence, 2);
    run.record("revert into m[0]", view.as_ref());

    add_summary(&run.session, 3, "Work again after the revert.");
    run.append_newest_summary();
    let view = run.build(true);
    run.record("appended summary after the fold", view.as_ref());
}

#[test]
fn kept_newer_summaries_give_the_bytes_a_fresh_computation_gives() {
    let mut kept = Run::new("head-cache-kept", true);
    let mut fresh = Run::new("head-cache-fresh", false);
    scenario(&mut kept);
    scenario(&mut fresh);
    assert_eq!(kept.records.len(), fresh.records.len());
    for (kept, fresh) in kept.records.iter().zip(&fresh.records) {
        for field in [
            "view",
            "baseline",
            "unconfirmed",
            "header",
            "checkpoint",
            "stored",
        ] {
            assert_eq!(
                kept[field], fresh[field],
                "{}: {field} differs between kept and fresh newer summaries",
                kept["state"]
            );
        }
    }
    std::fs::remove_dir_all(kept.dir).unwrap();
    std::fs::remove_dir_all(fresh.dir).unwrap();
}

/// Drop the newer summaries the last build kept, so the next build
/// computes them afresh.
fn forget_kept(session: &mut Session) {
    session.head_summaries = None;
}

/// Whether both baselines hold the one summary attribution list.
fn shares_summary_items(a: &Baseline, b: &Baseline) -> bool {
    a.summary_items.same(&b.summary_items)
}

/// The header as an app-read checkpoint saves it.
fn checkpoint_header(header: &crate::app_read::Header) -> String {
    header.json()
}
