use super::*;

#[tokio::test]
async fn lab_history_reranks_each_relevance_group_but_not_newest_or_disabled_searches() {
    use crate::search::rerank;
    const QUERY: &str = "How does sharedterm work here?";
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    conn.execute(
        "UPDATE compartments SET p1=?1 WHERE id=2",
        [format!("Full second tier {}", "é".repeat(800))],
    )
    .unwrap();
    for (sha, at) in [("old", 1000), ("new", 2000)] {
        conn.execute("INSERT INTO git_commits (sha,project_path,short_sha,message,author,committed_at,indexed_at)
            VALUES (?1,'p',?1,?2,'author',?3,1)", params![sha,QUERY,at]).unwrap();
    }
    drop(conn);
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["history_search"]);
    let mut lab = Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let trace = requests.clone();
    lab.ranking = ranking::Runtime::scripted(
        "lab-rerank-fixture",
        Box::new(move |session, module, method, input| {
            let trace = trace.clone();
            Box::pin(async move {
                assert_eq!(session.session, "rerank-lab");
                assert_eq!(module, "lab-rerank-fixture");
                let fingerprint = "a".repeat(64);
                if method == "models.list" {
                    return Ok(
                        json!({"result":{"table_epoch":7,"models":[{"model_id":rerank::MODEL,"serving_admission":"enabled","fingerprints":[fingerprint]}]}}),
                    );
                }
                assert_eq!(method, "rerank.score");
                assert_eq!(input["query"], QUERY);
                let documents = input["candidates"].as_array().unwrap();
                assert_eq!(documents.len(), 2, "{input}");
                assert!(documents
                    .iter()
                    .all(|document| document.as_str().unwrap().len() <= 1024));
                trace.lock().unwrap().push(input.clone());
                if documents[0].as_str().unwrap().starts_with("message ") {
                    return Err("test_score_refused".into());
                }
                Ok(json!({"result":{"fingerprint":fingerprint,"table_epoch":7,"scores":[0.1,0.9]}}))
            })
        }),
    );
    lab.ranking
        .bind(&cortexkit_role_compaction::read::SessionRef::new(
            "ra",
            "mock",
            "rerank-lab",
        ));
    let lab = Arc::new(lab);
    let search = |input| lab.clone().tool("history_search", input);
    let reranked = search(json!({"query":QUERY})).await.unwrap();
    assert!(
        group(&reranked, "Summaries")
            .lines()
            .next()
            .unwrap()
            .ends_with("ref=s2:1-4"),
        "{reranked}"
    );
    assert!(
        group(&reranked, "The person's messages")
            .lines()
            .next()
            .unwrap()
            .ends_with("ref=s1:12"),
        "{reranked}"
    );
    let newest = search(json!({"query":QUERY,"order":"newest"}))
        .await
        .unwrap();
    assert!(
        group(&newest, "Summaries")
            .lines()
            .next()
            .unwrap()
            .ends_with("ref=s1:1-4"),
        "{newest}"
    );
    search(json!({"query":"sharedterm"})).await.unwrap();
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let summary = requests
            .iter()
            .find(|r| {
                r["candidates"][0]
                    .as_str()
                    .unwrap()
                    .starts_with("compartment ")
            })
            .unwrap();
        assert!(summary["candidates"][1]
            .as_str()
            .unwrap()
            .contains("Full second tier"));
    }
    assert_eq!(
        lab.ranking.report(true),
        json!({"configured":true,"enabled":true,"calls":3,"failures":1,"pin_failures":0})
    );

    let mut lab = Arc::into_inner(lab).unwrap();
    lab.spec.rerank = false;
    let lab = Arc::new(lab);
    let disabled = lab
        .clone()
        .tool("history_search", json!({"query":QUERY}))
        .await
        .unwrap();
    assert!(
        group(&disabled, "Summaries")
            .lines()
            .next()
            .unwrap()
            .ends_with("ref=s1:1-4"),
        "{disabled}"
    );
    assert_eq!(requests.lock().unwrap().len(), 3);
    assert_eq!(lab.ranking.report(false)["enabled"], false);
}
