use super::*;

#[test]
fn chunk_text_and_windows_match_plugin_generated_fixture() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/chunk-embedding.json")).unwrap();
    let rows: Vec<FtsRow> = serde_json::from_value(fixture["rows"].clone()).unwrap();
    assert_eq!(canonical_text(&rows), fixture["canonical"]);
    assert_eq!(
        summary_fallback(
            "  Empty raw span  ",
            "  Useful fallback.\nSecond line. ",
            "Ignored legacy content."
        ),
        fixture["fallback"]
    );
    for case in fixture["cases"].as_array().unwrap() {
        let actual = windows(
            case["text"].as_str().unwrap(),
            case["start"].as_i64().unwrap(),
            case["end"].as_i64().unwrap(),
            case["max"].as_u64().unwrap(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            case["windows"],
            "max={}",
            case["max"]
        );
    }
}
