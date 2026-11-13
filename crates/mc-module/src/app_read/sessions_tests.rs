use super::fixture_tests::{head, worker, Fixture, EMPTY, PROJECT, T};
use super::*;

fn sessions(page: &Value) -> Vec<String> {
    page["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["session"]["session"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn sessions_page_lists_the_projects_compacted_sessions_newest_activity_first() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let page = replica
        .read("sessions.page", &json!({"project":PROJECT}))
        .unwrap();
    assert_eq!(sessions(&page), ["s", "s-worker", "s-reader"]);
    assert_eq!(
        page["sessions"][0],
        json!({"session": head(), "preset": "head", "last_activity_at": T + 9_000_000})
    );
    assert_eq!(page["sessions"][2]["preset"], "reader");
    let mut params = json!({"project":PROJECT,"limit":2});
    let first = replica.read("sessions.page", &params).unwrap();
    assert_eq!(sessions(&first), ["s", "s-worker"]);
    params["cursor"] = first["next"].clone();
    let second = replica.read("sessions.page", &params).unwrap();
    assert_eq!(sessions(&second), ["s-reader"]);
    assert!(second.get("next").is_none());
    let workers = replica
        .read(
            "sessions.page",
            &json!({"project":PROJECT,"preset":"worker"}),
        )
        .unwrap();
    assert_eq!(sessions(&workers), ["s-worker"]);
    let pi = replica
        .read("sessions.page", &json!({"project":PROJECT,"harness":"pi"}))
        .unwrap();
    assert_eq!(sessions(&pi), ["s-reader"]);
    // A session with no message yet has no last activity.
    let empty = replica
        .read("sessions.page", &json!({"project":EMPTY}))
        .unwrap();
    assert_eq!(
        empty["sessions"],
        json!([{"session":{"runner":"thalamus-harness","harness":"opencode2","session":"s-empty"},"preset":"head"}])
    );
    for (params, code) in [
        (json!({"project":"pj-never"}), "project_unknown"),
        (
            json!({"project":PROJECT,"preset":"dreamer"}),
            "invalid_params",
        ),
        (json!({"project":PROJECT,"limit":51}), "invalid_params"),
    ] {
        assert_eq!(
            replica.read("sessions.page", &params).unwrap_err().code,
            code
        );
    }
}

#[test]
fn a_session_set_up_in_this_process_joins_its_project_and_names_its_folder() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let moved = worker();
    replica.session_seen(
        moved.clone(),
        EMPTY.into(),
        "/work/empty".into(),
        "worker".into(),
    );
    let page = replica
        .read("sessions.page", &json!({"project":EMPTY}))
        .unwrap();
    assert_eq!(sessions(&page), ["s-worker", "s-empty"]);
    // A session belongs to one project.
    let old = replica
        .read("sessions.page", &json!({"project":PROJECT}))
        .unwrap();
    assert_eq!(sessions(&old), ["s", "s-reader"]);
    replica.session_seen(head(), "pj-new".into(), "/work/new".into(), "head".into());
    assert!(replica
        .read(
            "memories.page",
            &json!({"level":"project","owner":"pj-new"})
        )
        .is_ok());
}

#[test]
fn notes_page_shows_the_projects_notes_most_recently_updated_first() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let page = replica
        .read("notes.page", &json!({"project":PROJECT}))
        .unwrap();
    let ids: Vec<i64> = page["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|note| note["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [4, 3, 2, 1]);
    assert_eq!(
        page["notes"][0],
        json!({"id":4,"type":"smart","status":"ready","content":"Bump the pinned host.","created_at":1_700_000_300_000_i64,"updated_at":1_700_000_400_000_i64,"condition":"a new host release is out","ready_reason":"host 1.4.2 was released"})
    );
    // A session note names its session, with the runner when only one is
    // known for it.
    assert_eq!(page["notes"][3]["session"], json!(head()));
    let first = replica
        .read("notes.page", &json!({"project":PROJECT,"limit":3}))
        .unwrap();
    let second = replica
        .read(
            "notes.page",
            &json!({"project":PROJECT,"limit":3,"cursor":first["next"]}),
        )
        .unwrap();
    assert_eq!(second["notes"][0]["id"], 1);
    assert!(second.get("next").is_none());
    let smart = replica
        .read(
            "notes.page",
            &json!({"project":PROJECT,"type":"smart","status":"pending"}),
        )
        .unwrap();
    assert_eq!(smart["notes"].as_array().unwrap().len(), 1);
    let session = replica
        .read("notes.page", &json!({"project":PROJECT,"session":head()}))
        .unwrap();
    assert_eq!(session["notes"].as_array().unwrap().len(), 2);
    assert_eq!(
        replica
            .read("notes.page", &json!({"project":EMPTY}))
            .unwrap()["notes"],
        json!([])
    );
    for (params, code) in [
        (json!({"project":"pj-never"}), "project_unknown"),
        (json!({"project":PROJECT,"type":"memo"}), "invalid_params"),
        (json!({"project":PROJECT,"limit":101}), "invalid_params"),
    ] {
        assert_eq!(replica.read("notes.page", &params).unwrap_err().code, code);
    }
}

#[tokio::test]
async fn a_watch_follows_projects_workspaces_and_the_person() {
    let mut replica = super::tests::replica(None);
    let mut watch = replica
        .subscribe(
            "direct".into(),
            &json!({"projects":[PROJECT],"workspaces":["ws-1"],"global":true}),
        )
        .unwrap();
    let first = watch.recv().await.unwrap().unwrap();
    assert_eq!(first["kind"], "resync");
    assert_eq!(
        (
            first["sessions"].clone(),
            first["projects"].clone(),
            first["workspaces"].clone(),
            first["global"].clone()
        ),
        (json!([]), json!([PROJECT]), json!(["ws-1"]), json!(true))
    );
    replica
        .watches
        .publish(Change::project_memories("pj-other"));
    replica.watches.publish(Change::project_memories(PROJECT));
    let notice = watch.recv().await.unwrap().unwrap();
    assert_eq!(
        (
            notice["kind"].clone(),
            notice["level"].clone(),
            notice["owner"].clone()
        ),
        (json!("memories"), json!("project"), json!(PROJECT))
    );
    replica.watches.publish(Change::Memories {
        level: "workspace".into(),
        owner: "ws-1".into(),
    });
    assert_eq!(watch.recv().await.unwrap().unwrap()["owner"], "ws-1");
    replica.watches.publish(Change::global_memories());
    assert_eq!(watch.recv().await.unwrap().unwrap()["owner"], "self");
    replica.watches.publish(Change::Dreamer {
        project: PROJECT.into(),
    });
    let dreamer = watch.recv().await.unwrap().unwrap();
    assert_eq!(
        (dreamer["kind"].clone(), dreamer["project"].clone()),
        (json!("dreamer"), json!(PROJECT))
    );
    replica.watches.publish(Change::Notes {
        project: PROJECT.into(),
        session: Some(head()),
    });
    let notes = watch.recv().await.unwrap().unwrap();
    assert_eq!(
        (notes["kind"].clone(), notes["session"].clone()),
        (json!("notes"), json!(head()))
    );
    // A session change reaches only watches of that session.
    replica.watches.changed(head());
    replica.watches.publish(Change::Dreamer {
        project: PROJECT.into(),
    });
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "dreamer");
}

#[tokio::test]
async fn a_watch_resumed_from_its_cursor_hears_each_owner_change_once() {
    let mut replica = super::tests::replica(None);
    let params = json!({"sessions":[head()],"projects":[PROJECT]});
    let mut watch = replica.subscribe("direct".into(), &params).unwrap();
    let cursor = watch.recv().await.unwrap().unwrap()["cursor"].clone();
    drop(watch);
    replica.watches.publish(Change::project_memories(PROJECT));
    replica.watches.publish(Change::Dreamer {
        project: "pj-other".into(),
    });
    replica.watches.publish(Change::project_memories(PROJECT));
    replica.watches.changed(head());
    let mut resumed = params.clone();
    resumed["cursor"] = cursor;
    let mut watch = replica.subscribe("direct".into(), &resumed).unwrap();
    let first = watch.recv().await.unwrap().unwrap();
    assert_eq!(
        (first["kind"].clone(), first["sessions"].clone()),
        (json!("changes"), json!([head()]))
    );
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "memories");
    // More owner changes than the queue holds: start over.
    for index in 0..20 {
        replica.watches.publish(Change::project_memories(PROJECT));
        replica.watches.publish(Change::Notes {
            project: PROJECT.into(),
            session: Some(SessionRef::new("r", "h", index.to_string())),
        });
    }
    let mut late = params.clone();
    late["cursor"] = first["cursor"].clone();
    let mut watch = replica.subscribe("other".into(), &late).unwrap();
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "resync");
    for (params, field) in [
        (json!({}), "sessions"),
        (json!({"sessions":[]}), "sessions"),
        (json!({"projects":[PROJECT, PROJECT]}), "projects"),
        (json!({"projects":[""]}), "projects"),
        (json!({"global":"yes"}), "global"),
    ] {
        let refusal = replica.subscribe("direct".into(), &params).err().unwrap();
        assert_eq!(refusal.detail, Some(json!({"field": field})), "{params}");
    }
}

#[tokio::test]
async fn the_modules_writers_tell_the_watch_what_they_changed() {
    let fixture = Fixture::new();
    let path = fixture.dir.path().join("context.db");
    let db = crate::context_db::ContextDb::open(&path).unwrap();
    let app = AppRead::new(None, Some(path));
    db.notify(app.notifier());
    let mut watch = app
        .watch(
            "direct".into(),
            json!({"projects":[EMPTY, PROJECT],"global":true}),
        )
        .await
        .unwrap();
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "resync");
    // The dreamer schedules a project's tasks.
    let engine = crate::dreamer::engine::Engine::new("ck-mc:test", crate::dreamer::tasks());
    let profile = Arc::new(crate::memory_profile::prompt_profile(None).unwrap());
    engine.see_project(
        &db,
        EMPTY,
        "/nowhere",
        profile,
        &crate::dreamer::engine::Settings::default(),
        1,
    );
    let notice = watch.recv().await.unwrap().unwrap();
    assert_eq!(
        (notice["kind"].clone(), notice["project"].clone()),
        (json!("dreamer"), json!(EMPTY))
    );
    // A summary publishes candidate facts and an observation about the person.
    let compartment = crate::summary::validate::ValidatedCompartment {
        sequence: 1,
        start_message: 1,
        end_message: 2,
        start_message_id: "m1".into(),
        end_message_id: "m2".into(),
        title: "Work".into(),
        content: "Did work.".into(),
        p1: None,
        p2: None,
        p3: None,
        p4: None,
        importance: None,
        episode_type: None,
    };
    let recall = crate::context_db::Recall {
        events: Vec::new(),
        primer: None,
        observations: vec![crate::context_db::ObservationSource {
            category: "USER_PREFERENCES".into(),
            content: "Likes tables.".into(),
            start_ordinal: 1,
            end_ordinal: 2,
            project_id: Some(PROJECT.into()),
            workspace_id: None,
            profile: None,
        }],
    };
    db.publish_summaries("opencode2", "s", &[compartment], None, &recall, T)
        .unwrap();
    let notice = watch.recv().await.unwrap().unwrap();
    assert_eq!(
        (notice["kind"].clone(), notice["owner"].clone()),
        (json!("memories"), json!("self"))
    );
}
