use super::*;
use crate::reads::Limits;
use cortexkit_role_compaction::read::ReadName;
use cortexkit_role_compaction::ride::RideCause;
use cortexkit_role_compaction::setup::{Limits as Stated, PageLimits, WindowLimits};

fn stated() -> Stated {
    Stated::new()
        .with_page(PageLimits::new().with_max_entries(2).with_max_bytes(100))
        .with_select_max(256)
        .with_window(WindowLimits::new().with_entries(4).with_bytes(1024))
}

#[test]
fn limits_absent_partial_full_and_larger_than_our_request_sizes() {
    let absent = Limits::from_setup(None);
    assert_eq!(absent, Limits::default());
    let request = absent.after(None, None, Detail::Full);
    assert_eq!(
        request.select,
        Select::After {
            after_ordinal: None,
            limit: None
        }
    );
    assert_eq!(request.max_bytes, Some(1 << 20));
    assert_eq!((absent.window_entries, absent.window_bytes), (None, None));
    let partial = Limits::from_setup(Some(&Stated::new().with_select_max(3)));
    assert_eq!(partial.select_max, Some(3));
    assert_eq!(partial.page_entries, None);
    assert_eq!(partial.window_bytes, None);
    let full = Limits::from_setup(Some(&stated()));
    assert_eq!(full.page_entries, Some(2));
    assert_eq!(full.page_bytes, Some(100));
    assert_eq!(full.window_entries, Some(4));
    assert_eq!(full.window_bytes, Some(1024));
    assert_eq!(
        full.after(None, Some(10), Detail::Compact).select,
        Select::After {
            after_ordinal: None,
            limit: Some(2)
        }
    );
    let larger = Limits::from_setup(Some(
        &Stated::new().with_page(PageLimits::new().with_max_bytes(2 << 20)),
    ));
    assert_eq!(
        larger.after(None, None, Detail::Full).max_bytes,
        Some(1 << 20)
    );
}

#[test]
fn compaction_037_wire_vectors_decode() {
    fn vector(name: &str) -> Value {
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/compaction-0.3.7");
        serde_json::from_slice(&std::fs::read(base.join(name)).unwrap()).unwrap()
    }
    for name in [
        "setup-limits-request.json",
        "setup-limits-legacy-request.json",
    ] {
        let setup: SetupRequest = serde_json::from_value(vector(name)["params"].clone()).unwrap();
        let limits = Limits::from_setup(setup.limits.as_ref());
        assert_eq!(limits.page_entries, Some(512));
        assert_eq!(limits.page_bytes, Some(1 << 20));
        assert_eq!(limits.select_max, Some(256));
        assert_eq!(
            (limits.window_entries, limits.window_bytes),
            (Some(8_000), Some(64 << 20))
        );
    }
    let notice: NoticeRequest =
        serde_json::from_value(vector("notice-window-over-budget-request.json")["params"].clone())
            .unwrap();
    assert_eq!(notice.conditions.window_over_budget, Some(true));
    let ride: RideRequest =
        serde_json::from_value(vector("ride-window-over-budget-request.json")["params"].clone())
            .unwrap();
    assert_eq!(ride.causes, vec![RideCause::WindowOverBudget]);
    for (name, expected) in [
        (
            "entries-unanswered-mids.json",
            ReadName::Mid("message-b".into()),
        ),
        ("entries-unanswered-tags.json", ReadName::Tag(2)),
    ] {
        let page: ReadPage = serde_json::from_value(vector(name)).unwrap();
        assert_eq!(page.unanswered, Some(vec![expected]));
    }
    let refusal: cortexkit_role_compaction::wire::Refusal =
        serde_json::from_value(vector("refusal-select-too-many.json")).unwrap();
    assert_eq!(refusal.code, "invalid_params");
    assert_eq!(refusal.detail.unwrap()["max"], 256);
}

fn pages(client: &Client, entries: &[Entry], size: usize) {
    let mut head = Head::new();
    head.newest = entries.last().map(cursor);
    for chunk in entries.chunks(size) {
        let mut page = ReadPage::new(chunk.to_vec(), head.clone());
        if chunk.last().unwrap().ordinal != entries.last().unwrap().ordinal {
            page.next_after = Some(chunk.last().unwrap().ordinal);
        }
        client.pages.lock().unwrap().push_back(Ok(page));
    }
}

#[tokio::test]
async fn after_three_pages_obey_setup_limits_and_first_notice_is_delta() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let entries: Vec<_> = (1..=7).map(|n| text(n, &format!("m{n}"))).collect();
    setup.limits = Some(stated());
    setup.newest = Some(cursor(&entries[4]));
    pages(&client, &entries[..5], 2);
    session
        .setup(&client, &settings, &route, &setup, session.features)
        .await;
    assert!(session.index_ready);
    let requests = client.reads.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    for (request, after) in requests.iter().zip([None, Some(2), Some(4)]) {
        assert_eq!(
            request.select,
            Select::After {
                after_ordinal: after,
                limit: Some(2)
            }
        );
        assert_eq!(request.max_bytes, Some(100));
    }
    let mut delta = notice(&session, 1, Some(cursor(&entries[6])));
    delta.entries = entries[5..].to_vec();
    assert!(session.notice(&client, &settings, delta).await.is_none());
    assert_eq!(session.index.entries(), entries.as_slice());
    assert_eq!(
        client.reads.lock().unwrap().len(),
        3,
        "first delta does not replay history"
    );
    setup.limits = None;
    *client.entries.lock().unwrap() = entries;
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    session
        .setup(&client, &settings, &route, &setup, session.features)
        .await;
    assert_eq!(
        session.limits,
        Limits::default(),
        "each Setup replaces every stated limit"
    );
}

#[tokio::test]
async fn full_after_three_pages_obey_limits_and_next_after() {
    let (_, client, route, _, _) = fixture();
    let entries: Vec<_> = (1..=5).map(|n| text(n, &format!("m{n}"))).collect();
    pages(&client, &entries, 2);
    let got = crate::reads::full_range(
        &client,
        &route.session,
        1,
        6,
        Limits::from_setup(Some(&stated())),
        |_| false,
    )
    .await
    .unwrap();
    assert_eq!(got, entries);
    for (request, after) in client
        .reads
        .lock()
        .unwrap()
        .iter()
        .zip([Some(0), Some(2), Some(4)])
    {
        assert_eq!(
            request.select,
            Select::After {
                after_ordinal: after,
                limit: Some(2)
            }
        );
        assert_eq!(request.max_bytes, Some(100));
    }
}

#[tokio::test]
async fn named_600_mids_retry_exact_unanswered_in_order() {
    let (_, client, route, _, _) = fixture();
    let entries: Vec<_> = (1..=600).map(|n| text(n, &format!("m{n}"))).collect();
    let mut first = ReadPage::new(entries[..250].to_vec(), Head::new());
    first.unanswered = Some(
        entries[250..256]
            .iter()
            .map(|e| ReadName::Mid(e.mid.clone()))
            .collect(),
    );
    client.pages.lock().unwrap().extend([
        Ok(first),
        Ok(ReadPage::new(entries[250..256].to_vec(), Head::new())),
        Ok(ReadPage::new(entries[256..512].to_vec(), Head::new())),
        Ok(ReadPage::new(entries[512..].to_vec(), Head::new())),
    ]);
    let got = crate::reads::named(
        &client,
        &route.session,
        entries.iter().map(|e| e.mid.clone()).collect(),
        Limits::from_setup(Some(&stated())),
        |mids| Select::Mids { mids },
    )
    .await
    .unwrap();
    assert_eq!(got, entries);
    let reads = client.reads.lock().unwrap();
    assert_eq!(reads.len(), 4);
    for (request, range) in reads.iter().zip([0..256, 250..256, 256..512, 512..600]) {
        assert_eq!(
            request.select,
            Select::Mids {
                mids: entries[range].iter().map(|e| e.mid.clone()).collect()
            }
        );
    }
}

#[tokio::test]
async fn named_tags_smaller_larger_zero_limits_and_missing_names() {
    for (ceiling, sizes) in [
        (Some(2), vec![2, 2, 1]),
        (Some(1000), vec![5]),
        (None, vec![5]),
    ] {
        let (_, client, route, _, _) = fixture();
        // A missing name not listed as unanswered is not retried.
        for _ in &sizes {
            client
                .pages
                .lock()
                .unwrap()
                .push_back(Ok(ReadPage::new(vec![], Head::new())));
        }
        let limits = Limits {
            select_max: ceiling,
            ..Limits::default()
        };
        assert!(
            crate::reads::by_tags(&client, &route.session, (1..=5).collect(), limits)
                .await
                .unwrap()
                .is_empty()
        );
        let reads = client.reads.lock().unwrap();
        assert_eq!(reads.len(), sizes.len());
        let mut offset = 1;
        for (request, size) in reads.iter().zip(sizes) {
            assert_eq!(
                request.select,
                Select::Tags {
                    tags: (offset..offset + size).collect()
                }
            );
            offset += size;
        }
    }
    let (_, client, route, _, _) = fixture();
    let mut page = ReadPage::new(vec![text(1, "m1")], Head::new());
    page.unanswered = Some(vec![ReadName::Tag(3), ReadName::Tag(2)]);
    client.pages.lock().unwrap().extend([
        Ok(page),
        Ok(ReadPage::new(
            vec![text(3, "m3"), text(2, "m2")],
            Head::new(),
        )),
    ]);
    let got = crate::reads::by_tags(&client, &route.session, vec![1, 3, 2], Limits::default())
        .await
        .unwrap();
    assert_eq!(
        got.iter().map(|e| e.ordinal).collect::<Vec<_>>(),
        vec![1, 3, 2]
    );
    assert_eq!(
        client.reads.lock().unwrap()[1].select,
        Select::Tags { tags: vec![3, 2] }
    );
    let zero = Limits {
        select_max: Some(0),
        ..Limits::default()
    };
    assert!(
        crate::reads::by_tags(&client, &route.session, vec![1], zero)
            .await
            .is_err()
    );
    assert_eq!(client.reads.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn runner_fault_empty_continuing_page_fails_compact_and_full_reads_once() {
    let capture = crate::test_log::capture();
    for compact in [true, false] {
        let (mut session, client, _, _, _) = fixture();
        let mut page = ReadPage::new(vec![], Head::new());
        page.next_after = Some(9);
        client.pages.lock().unwrap().push_back(Ok(page));
        if compact {
            assert!(!session.read_until_from(&client, None, true, Some(7)).await);
        } else {
            assert!(crate::reads::full_range(
                &client,
                &session.key,
                8,
                20,
                Limits::default(),
                |_| false
            )
            .await
            .is_err());
        }
        assert_eq!(client.reads.lock().unwrap().len(), 1);
    }
    let log = capture.text();
    let faults: Vec<_> = log
        .lines()
        .filter(|line| line.contains("empty read page"))
        .collect();
    assert_eq!(faults.len(), 2);
    assert!(faults
        .iter()
        .all(|line| line.contains("WARN") && line.contains("s1") && line.contains('7')));
}

#[tokio::test]
async fn runner_fault_named_all_unanswered_fails_once_for_mids_and_tags() {
    let capture = crate::test_log::capture();
    for mids in [true, false] {
        let (_, client, route, _, _) = fixture();
        let mut page = ReadPage::new(vec![], Head::new());
        page.unanswered = Some(if mids {
            vec![ReadName::Mid("m1".into())]
        } else {
            vec![ReadName::Tag(1)]
        });
        client.pages.lock().unwrap().push_back(Ok(page));
        if mids {
            assert!(crate::reads::named(
                &client,
                &route.session,
                vec!["m1".to_owned()],
                Limits::default(),
                |mids| Select::Mids { mids }
            )
            .await
            .is_err());
        } else {
            assert!(
                crate::reads::by_tags(&client, &route.session, vec![1], Limits::default())
                    .await
                    .is_err()
            );
        }
        assert_eq!(client.reads.lock().unwrap().len(), 1);
    }
    assert_eq!(
        capture
            .text()
            .lines()
            .filter(|line| line.contains("WARN")
                && line.contains("s1")
                && line.contains("left all names unanswered"))
            .count(),
        2
    );
}

#[tokio::test]
async fn window_flag_logs_once_per_crossing_and_changes_no_policy() {
    let capture = crate::test_log::capture();
    let (mut session, client, _, _, settings) = fixture();
    session.features.summarizer = true;
    session.index.extend([text(1, "one")]);
    session.index_ready = true;
    session.limits = Limits::from_setup(Some(&stated()));
    // Settle the ordinary first-render reason before testing a budget signal.
    let view = session.build(&settings, None, false, None).0.unwrap();
    let version = view.version;
    session.accept(view);
    session.runner_holds(version);
    let applied = session
        .latest
        .as_ref()
        .map(|v| AppliedView::new(v.version, v.checksum.clone()));
    session.settle_unconfirmed(applied.as_ref(), &[]);
    let before = serde_json::to_value(session.durable()).unwrap();
    for (i, flag) in [Some(true), Some(true), None, Some(true)]
        .into_iter()
        .enumerate()
    {
        let mut n = notice(&session, i as u64 + 1, session.index.cursor());
        n.conditions.window_over_budget = flag;
        n.applied_view = session.latest.as_ref().map(|v| {
            cortexkit_role_compaction::view::AppliedView::new(v.version, v.checksum.clone())
        });
        n.entries = session.index.entries().to_vec();
        assert!(
            session.notice(&client, &settings, n).await.is_none(),
            "no summary trigger"
        );
        assert!(
            !session.rebuild_permitted(&settings),
            "no rebuild permission"
        );
        assert_eq!(session.cut, None);
        assert!(client.offered.lock().unwrap().is_empty(), "no view");
    }
    // Conditions record the runner's latest report; the flag changes no policy state.
    session.conditions.window_over_budget = None;
    assert_eq!(serde_json::to_value(session.durable()).unwrap(), before);
    let log = capture.text();
    let crossings: Vec<_> = log
        .lines()
        .filter(|line| line.contains("INFO") && line.contains("window_over_budget:"))
        .collect();
    assert_eq!(crossings.len(), 2);
    assert!(crossings.iter().all(|line| line.contains("s1")
        && line.contains("1 entries")
        && line.contains("Some(4)")
        && line.contains("Some(1024)")));
    let mut ride = RideRequest::new(
        vec![RideCause::WindowOverBudget],
        1000,
        session.conditions.clone(),
    );
    ride.applied_view = session
        .latest
        .as_ref()
        .map(|v| cortexkit_role_compaction::view::AppliedView::new(v.version, v.checksum.clone()));
    assert!(
        session.ride(&settings, &ride).is_none(),
        "nothing is valid without an independent rebuild reason"
    );
    let (mut session, _, _, _, _) = fixture();
    session.features.summarizer = true;
    session.index.extend([text(1, "one")]);
    session.index_ready = true;
    session.head_stale = true;
    ride.conditions = session.conditions.clone();
    ride.applied_view = None;
    assert!(
        session.ride(&settings, &ride).is_some(),
        "independently due work still lands"
    );
}

#[tokio::test]
async fn flag_without_a_stated_window_budget_logs_fault_and_still_does_nothing() {
    let capture = crate::test_log::capture();
    let (mut session, client, _, _, settings) = fixture();
    session.index_ready = true;
    let mut n = notice(&session, 1, None);
    n.conditions.window_over_budget = Some(true);
    assert!(session.notice(&client, &settings, n).await.is_none());
    assert!(client.offered.lock().unwrap().is_empty());
    assert!(!session.rebuild_permitted(&settings));
    let log = capture.text();
    assert_eq!(
        log.lines()
            .filter(|line| line.contains("INFO")
                && line.contains("window_over_budget:")
                && line.contains("entries None, bytes None"))
            .count(),
        1
    );
    assert_eq!(
        log.lines()
            .filter(|line| line.contains("WARN") && line.contains("without a stated window budget"))
            .count(),
        1
    );
}

#[tokio::test]
async fn named_larger_stated_select_max_keeps_our_256_name_request_size() {
    let (_, client, route, _, _) = fixture();
    for _ in 0..3 {
        client
            .pages
            .lock()
            .unwrap()
            .push_back(Ok(ReadPage::new(vec![], Head::new())));
    }
    let limits = Limits {
        select_max: Some(1000),
        ..Limits::default()
    };
    crate::reads::by_tags(&client, &route.session, (1..=600).collect(), limits)
        .await
        .unwrap();
    let reads = client.reads.lock().unwrap();
    assert_eq!(reads.len(), 3);
    for (request, range) in reads.iter().zip([1..257, 257..513, 513..601]) {
        assert_eq!(
            request.select,
            Select::Tags {
                tags: range.collect()
            }
        );
    }
}

#[tokio::test]
async fn named_runner_fault_in_a_view_build_warns_only_once() {
    let capture = crate::test_log::capture();
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![super::named_read_tests::image_result(1)];
    super::named_read_tests::hold_compact_images(&mut session, &entries);
    let mut page = ReadPage::new(vec![], Head::new());
    page.unanswered = Some(vec![ReadName::Mid(entries[0].mid.clone())]);
    client.pages.lock().unwrap().push_back(Ok(page));
    session.build_now(&client, &settings).await;
    assert_eq!(client.reads.lock().unwrap().len(), 1);
    assert!(session.image_outputs.is_empty());
    assert_eq!(
        capture
            .text()
            .lines()
            .filter(|line| line.contains("WARN"))
            .count(),
        1
    );
}
