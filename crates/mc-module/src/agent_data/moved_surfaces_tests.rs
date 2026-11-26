//! The surfaces that list a project's sessions and notes, and the person's
//! note commands, on the machine a session moved away from: none of them
//! shows or changes the moved session, before a restart or after one, and
//! the session can move back as the move left it.

use super::*;

fn occipital() -> subc_protocol::Principal {
    subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    }
}

impl Machine {
    /// What `mode3.db` keeps of a primary session (preset `head`, one a
    /// person works in) of [`PROJECT`] that this machine served: its
    /// project and its preset. A restart reads the project's
    /// sessions from it.
    fn served_before(&self, session: &str) {
        let conn = Connection::open(self.dir.path().join("sessions.db")).unwrap();
        conn.execute(
            "INSERT INTO memory_contexts (runner, harness, session, context) VALUES (?1, ?2, ?3, ?4)",
            params![RUNNER, HARNESS, session, json!({"project_id": PROJECT}).to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (runner, harness, session, state) VALUES (?1, ?2, ?3, ?4)",
            params![
                RUNNER,
                HARNESS,
                session,
                json!({"preset": "head"}).to_string()
            ],
        )
        .unwrap();
    }

    /// The sessions `sessions.page` lists for [`PROJECT`].
    async fn listed(&self) -> Vec<String> {
        let page = self
            .module
            .app_request("sessions.page", json!({"project": PROJECT}))
            .await
            .unwrap();
        let mut sessions: Vec<String> = page["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["session"]["session"].as_str().unwrap().to_owned())
            .collect();
        sessions.sort();
        sessions
    }

    /// The session of each session note `notes.page` lists for [`PROJECT`].
    async fn noted(&self) -> Vec<String> {
        let page = self
            .module
            .app_request("notes.page", json!({"project": PROJECT}))
            .await
            .unwrap();
        let mut sessions: Vec<String> = page["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["session"]["session"].as_str().unwrap().to_owned())
            .collect();
        sessions.sort();
        sessions
    }

    fn note_of(&self, session: &str) -> i64 {
        self.conn()
            .query_row(
                "SELECT id FROM notes WHERE session_id = ?1",
                [session],
                |row| row.get(0),
            )
            .unwrap()
    }

    async fn command(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, subc_protocol::ErrorBody> {
        let body = serde_json::to_vec(&json!({"method": method, "params": params})).unwrap();
        self.module.command_request(&occipital(), &body).await
    }

    async fn preview(&self, id: &str, args: Value) -> Result<Value, subc_protocol::ErrorBody> {
        self.command(
            "commands.preview",
            json!({
                "id": id,
                "subject": {"kind": "project", "project_id": PROJECT},
                "args": args,
                "caller": {"app": "desktop", "admission": "operator_app"},
            }),
        )
        .await
    }

    async fn run(
        &self,
        id: &str,
        args: Value,
        version: &str,
    ) -> Result<Value, subc_protocol::ErrorBody> {
        self.command(
            "commands.run",
            json!({
                "id": id,
                "subject": {"kind": "project", "project_id": PROJECT},
                "args": args,
                "caller": {"app": "desktop", "admission": "operator_app"},
                "preview_version": version,
                "request_id": format!("{id}-1"),
            }),
        )
        .await
    }
}

/// Machine A served `s1` and `s2` of the project, restarted, and moved `s1`
/// to machine B.
async fn moved_one_of_two() -> (Machine, Machine) {
    let (a, b) = machines(&["s1"]);
    for session in ["s1", "s2"] {
        seed(&a.conn(), session, PROJECT);
        a.served_before(session);
    }
    let a = a.restart().await;
    move_session(&a, &b, CUT, "machine-b").await;
    (a, b)
}

/// `sessions.page` lists the project's sessions a move doesn't hold, and
/// lists the same after a restart.
#[tokio::test]
async fn sessions_page_leaves_out_a_moved_session_before_and_after_a_restart() {
    let (a, _b) = moved_one_of_two().await;
    assert_eq!(a.listed().await, ["s2"]);
    let a = a.restart().await;
    assert_eq!(a.listed().await, ["s2"]);
}

/// A project-wide `notes.page` leaves out a moved session's notes, as a
/// read naming the session is refused.
#[tokio::test]
async fn notes_page_leaves_out_a_moved_sessions_notes() {
    let (a, _b) = moved_one_of_two().await;
    assert_eq!(a.noted().await, ["s2"]);
    let a = a.restart().await;
    assert_eq!(a.noted().await, ["s2"]);
}

/// The person's note commands refuse a moved session's note with the move's
/// refusal and leave it as the move found it, so the session moves back to
/// this machine. Another session's note is still served.
#[tokio::test]
async fn note_commands_refuse_a_moved_sessions_note_and_the_session_moves_back() {
    let (a, b) = moved_one_of_two().await;
    let before = a.fingerprint("s1");
    let moved = a.note_of("s1");
    let edit = json!({"id": moved, "content": "Edited on the old machine."});
    let preview = a.preview("note_edit", edit.clone()).await;
    let version = preview
        .as_ref()
        .ok()
        .and_then(|preview| preview["version"].as_str())
        .unwrap_or("unknown")
        .to_owned();
    let ran = a.run("note_edit", edit, &version).await;
    assert_eq!(preview.unwrap_err().code, SESSION_MOVED);
    assert_eq!(ran.unwrap_err().code, SESSION_MOVED);
    for id in ["note_dismiss", "note_delete"] {
        let refused = a
            .preview(id, json!({"ids": moved.to_string()}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, SESSION_MOVED, "{id}");
    }
    assert_eq!(a.fingerprint("s1"), before);
    let kept = a.note_of("s2");
    let preview = a
        .preview("note_edit", json!({"id": kept, "content": "Edited here."}))
        .await
        .unwrap();
    assert_eq!(preview["available"], true, "{preview}");
    move_session(&b, &a, BACK, "machine-a").await;
    assert_eq!(a.fingerprint("s1"), before);
}
