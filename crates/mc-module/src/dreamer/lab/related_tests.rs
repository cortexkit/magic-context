use super::*;

const MEMORY_7: &str = concat!(
    "### Memory 7\nCategory: swe:architecture\nCreated: 1970-01-01T00:00:01+00:00\n",
    "Writer: summarizer\nImportance: 72\nLast confirmed: 1970-01-01T00:00:02+00:00\n",
    "Linked files: src/example.rs\n\nInvariant sharedterm from the frozen fixture.\n\n",
);
const MEMORY_2: &str = concat!(
    "### Memory 2\nCategory: swe:architecture\nCreated: 1970-01-01T00:00:01+00:00\n",
    "Writer: agent\nImportance: 72\nLast confirmed: 1970-01-01T00:00:02+00:00\n",
    "Linked files: none\n\nSecond memory from the frozen fixture.\n\n",
);

fn scoped_spec(fixture: &Fixture) -> Value {
    let mut spec = fixture.spec_value();
    spec["history_sessions"] = json!(["session-p"]);
    spec
}

#[tokio::test]
async fn no_related_keeps_the_first_message_byte_for_byte() {
    let fixture = Fixture::new();
    fixture
        .run(scoped_spec(&fixture), Ends::LabTools(vec![]))
        .await;
    assert_eq!(fixture.output("request.json")["first_message"], format!(
        "## Context note\n\nA fixed context note.\n\n{MEMORY_7}{MEMORY_2}\nCall `submit` with the verdicts. Git is available."
    ));
}

fn add_related_rows(fixture: &Fixture) {
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'Own', 1, 1), (2, 'Outside', 1, 1);
         INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'p', 'Project', '/p', 1), (2, 'secret', 'Other', '/other', 1);",
    ).unwrap();
    for (id, level, owner, at, content) in [
        (
            3,
            "project",
            "p",
            86_401_000,
            "The project's full note.\nThe second line stays.",
        ),
        (
            4,
            "workspace",
            "1",
            172_801_000,
            "The workspace's full note.",
        ),
        (5, "workspace", "2", 1000, "A different workspace's note."),
    ] {
        conn.execute(
            "INSERT INTO memories (id, level, owner_id, category, origin_category, content, normalized_hash,
                first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, ?2, ?3, 'swe:constraints', 'CONSTRAINTS', ?5, ?5, 1, ?4, ?4, ?4)",
            params![id, level, owner, at, content],
        ).unwrap();
    }
}

#[tokio::test]
async fn related_render_in_spec_order_with_one_full_text_and_a_pointer() {
    let fixture = Fixture::new();
    add_related_rows(&fixture);
    let mut spec = scoped_spec(&fixture);
    spec["related"] = json!({"7":[4,3],"2":[3]});
    fixture.run(spec, Ends::LabTools(vec![])).await;
    let request = fixture.output("request.json");
    let prompt = request["first_message"].as_str().unwrap();
    assert!(prompt.contains(&format!("{MEMORY_7}Related memories outside your set:\n#4 swe:constraints (1970-01-03): The workspace's full note.\n#3 swe:constraints (1970-01-02): The project's full note.\nThe second line stays.\n\n{MEMORY_2}Related memories outside your set:\n#3 (shown under memory 7)\n")), "{prompt}");
    assert_eq!(prompt.matches("The project's full note.").count(), 1);
}

#[tokio::test]
async fn related_rejects_bad_judged_keys_out_of_scope_rows_and_lists_over_eight() {
    let fixture = Fixture::new();
    add_related_rows(&fixture);
    for (related, explanation) in [
        (json!({"3":[4]}), "memory 3 is not in memory_ids"),
        (json!({"7":[2]}), "memory 2 is in memory_ids"),
        (json!({"7":[999]}), "related memory 999"),
        (json!({"7":[9]}), "related memory 9"),
        (json!({"7":[5]}), "related memory 5"),
        (
            json!({"7":[3,3,3,3,3,3,3,3,4]}),
            "memory 7 lists 9 related memories",
        ),
    ] {
        let mut spec = scoped_spec(&fixture);
        spec["related"] = related;
        let error = fixture
            .start(&spec)
            .await
            .err()
            .expect("refused before reserving output");
        assert!(error.contains(explanation), "{error}");
        assert!(!fixture.out.exists());
    }
}

#[tokio::test]
async fn related_is_not_in_the_set_the_submit_tool_can_judge() {
    let fixture = Fixture::new();
    add_related_rows(&fixture);
    let mut spec = scoped_spec(&fixture);
    spec["related"] = json!({"7":[3]});
    let lab = Arc::new(Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap());
    let error = lab
        .tool(
            "submit",
            json!({"verdicts":[verdict(3,"Not part of the set")]}),
        )
        .await
        .unwrap_err();
    assert!(error.contains("memory 3 is outside the set"), "{error}");
    assert_eq!(fixture.output("verdicts.json"), json!([]));
}
