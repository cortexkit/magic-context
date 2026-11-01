//! Pure Rust port of note ranking from `search.ts` at frozen revision 282d9c08bce4.

use std::collections::HashMap;

use super::hybrid::{preview, trim_query, DateBounds, SINGLE_SOURCE_PENALTY};

const NOTE_SEARCHABLE_STATUSES: [NoteStatus; 3] =
    [NoteStatus::Active, NoteStatus::Pending, NoteStatus::Ready];
const MAX_NOTE_KEYWORD_SCORE: f64 = 3.5;
const PROBE_IDF_FALLOFF: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteType {
    Session,
    Smart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteStatus {
    Active,
    Pending,
    Ready,
    Dismissed,
}

impl NoteStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRow {
    pub id: i64,
    pub note_type: NoteType,
    pub status: NoteStatus,
    pub content: String,
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub surface_condition: Option<String>,
    pub ready_reason: Option<String>,
    pub created_at: i64,
    pub anchor_ordinal: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NoteHit {
    pub content: String,
    pub score: f64,
    pub note_id: i64,
    pub status: NoteStatus,
    pub created_at: i64,
    pub anchor_ordinal: Option<i64>,
    pub source_session_id: Option<String>,
}

#[derive(Clone)]
struct RankedNote<'a> {
    note: &'a NoteRow,
    score: f64,
    text: String,
}

/// Rank in-scope notes without consulting a store or changing the source rows.
pub fn rank_notes(
    notes: &[NoteRow],
    session_id: &str,
    project_path: &str,
    query: &str,
    probes: &[String],
    dates: DateBounds,
    limit: usize,
) -> Vec<NoteHit> {
    if limit == 0 {
        return Vec::new();
    }

    let candidates: Vec<_> = notes
        .iter()
        .filter(|note| {
            NOTE_SEARCHABLE_STATUSES.contains(&note.status)
                && match note.note_type {
                    NoteType::Session => note.session_id.as_deref() == Some(session_id),
                    NoteType::Smart => note.project_path.as_deref() == Some(project_path),
                }
                && dates.contains(note.created_at)
        })
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }

    let base_list = rank_notes_for_needle(&candidates, query);
    if probes.is_empty() {
        return base_list
            .into_iter()
            .take(limit)
            .map(|entry| {
                let score = entry.score;
                make_hit(entry, score)
            })
            .collect();
    }

    let mut query_lists = Vec::new();
    if !base_list.is_empty() {
        query_lists.push((base_list, 1.0));
    }
    for probe in probes {
        let rows = rank_notes_for_needle(&candidates, probe);
        if rows.is_empty() {
            continue;
        }
        let weight = probe_discrimination_weight(rows.len(), candidates.len());
        query_lists.push((rows, weight));
    }

    let mut fused: Vec<(RankedNote<'_>, f64)> = Vec::new();
    let mut indexes: HashMap<i64, usize> = HashMap::new();
    // Multiple probes can match one note; retain its strongest weighted score, not their sum.
    for (rows, weight) in query_lists {
        for row in rows {
            let relevance = row.score * weight;
            if let Some(&index) = indexes.get(&row.note.id) {
                if relevance > fused[index].1 {
                    fused[index] = (row, relevance);
                }
            } else {
                indexes.insert(row.note.id, fused.len());
                fused.push((row, relevance));
            }
        }
    }

    fused.sort_by(|(left, left_score), (right, right_score)| {
        right_score
            .total_cmp(left_score)
            .then_with(|| compare_note_order(left.note, right.note))
    });
    fused
        .into_iter()
        .take(limit)
        .map(|(entry, score)| make_hit(entry, score))
        .collect()
}

fn compare_note_order(left: &NoteRow, right: &NoteRow) -> std::cmp::Ordering {
    right
        .created_at
        .cmp(&left.created_at)
        .then_with(|| left.id.cmp(&right.id))
}

fn make_hit(entry: RankedNote<'_>, score: f64) -> NoteHit {
    NoteHit {
        content: preview(&entry.text),
        score: normalize_note_keyword_score(score),
        note_id: entry.note.id,
        status: entry.note.status,
        created_at: entry.note.created_at,
        anchor_ordinal: entry.note.anchor_ordinal,
        source_session_id: entry.note.session_id.clone(),
    }
}

fn note_search_text(note: &NoteRow) -> String {
    // A smart note's surface condition is its trigger; `ready_reason` records why it matched.
    // Search that reason with the note body so ready notes are found by the explanation too.
    let reason = note.ready_reason.as_deref().map(trim_query).unwrap_or("");
    if reason.is_empty() {
        note.content.clone()
    } else {
        format!("{}\nReason: {reason}", note.content)
    }
}

fn tokenize_keyword_needle(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut token = String::new();
    for character in text.chars().chain(std::iter::once(' ')) {
        if character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '_' | ':' | '-') {
            token.push(character);
        } else if !token.is_empty() {
            if token.len() > 1
                && token.bytes().any(|byte| byte.is_ascii_alphanumeric())
                && seen.insert(token.clone())
            {
                tokens.push(token.clone());
            }
            token.clear();
        }
    }
    tokens
}

fn rank_notes_for_needle<'a>(notes: &[&'a NoteRow], needle: &str) -> Vec<RankedNote<'a>> {
    let normalized_needle = trim_query(needle).to_lowercase();
    if normalized_needle.is_empty() {
        return Vec::new();
    }
    let needle_tokens = tokenize_keyword_needle(&normalized_needle);
    let mut ranked = Vec::new();
    for note in notes {
        let text = note_search_text(note);
        let normalized_text = text.to_lowercase();
        let note_tokens: std::collections::HashSet<_> = tokenize_keyword_needle(&normalized_text)
            .into_iter()
            .collect();
        let exact = normalized_text.contains(&normalized_needle);
        let matched_tokens = needle_tokens
            .iter()
            .filter(|token| note_tokens.contains(token.as_str()))
            .count();
        if !exact && matched_tokens == 0 {
            continue;
        }
        let matched_unique_tokens = needle_tokens
            .iter()
            .filter(|token| note_tokens.contains(token.as_str()))
            .collect::<std::collections::HashSet<_>>()
            .len();
        let coverage = if needle_tokens.is_empty() {
            0.0
        } else {
            matched_tokens as f64 / needle_tokens.len() as f64
        };
        let density = if note_tokens.is_empty() {
            0.0
        } else {
            matched_unique_tokens as f64 / note_tokens.len() as f64
        };
        let exact_phrase =
            exact && (needle_tokens.len() > 1 || trim_query(&normalized_text) == normalized_needle);
        let all_tokens = needle_tokens.len() > 1 && matched_tokens == needle_tokens.len();
        let score = (if exact_phrase { 2.0 } else { 0.0 })
            + coverage * density
            + (if all_tokens { 0.5 * density } else { 0.0 });
        ranked.push(RankedNote { note, score, text });
    }
    ranked.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| compare_note_order(left.note, right.note))
    });
    ranked
}

fn normalize_note_keyword_score(score: f64) -> f64 {
    // Preserve the f64 keyword score as the ranking signal instead of rounding it.
    if !score.is_finite() {
        return 0.0;
    }
    (score / MAX_NOTE_KEYWORD_SCORE).clamp(0.0, 1.0) * SINGLE_SOURCE_PENALTY
}

fn probe_discrimination_weight(document_frequency: usize, corpus_size: usize) -> f64 {
    if corpus_size == 0 || document_frequency == 0 {
        return 1.0;
    }
    1.0 / (1.0 + (PROBE_IDF_FALLOFF * document_frequency as f64) / corpus_size as f64)
}

#[cfg(test)]
mod tests {
    use super::{rank_notes, NoteHit, NoteRow, NoteStatus, NoteType};
    use crate::retrieval::hybrid::DateBounds;
    use serde::Deserialize;

    const TS_FIXTURE: &str = r###"
{"n":"plain_exact_phrase","r":[{"i":1,"c":"alpha beta"}],"q":"alpha beta","x":[{"i":1,"s":0.8}]}
{"n":"plain_fractional_density","r":[{"i":2,"c":"alpha beta gamma delta"}],"q":"alpha beta","x":[{"i":2,"s":0.6285714285714286}]}
{"n":"ready_reason_searches_not_surface_condition","r":[{"i":3,"c":"the stored instruction","t":"smart","s":"ready","sc":"only on deployment","rr":"  alpha beta applies  "}],"q":"alpha beta","x":[{"i":3,"s":0.5551020408163265}]}
{"n":"pending_smart_note","r":[{"i":4,"c":"alpha beta","t":"smart","s":"pending"}],"q":"alpha beta","x":[{"i":4,"s":0.8}]}
{"n":"dismissed_note_excluded","r":[{"i":5,"c":"alpha beta","s":"dismissed"}],"q":"alpha beta","x":[]}
{"n":"unicode_exact_text","r":[{"i":6,"c":"café"}],"q":"café","x":[{"i":6,"s":0.6857142857142857}]}
{"n":"unicode_prose_and_ascii_token","r":[{"i":7,"c":"résumé policy α beta"}],"q":"policy beta","x":[{"i":7,"s":0.22857142857142856}]}
{"n":"punctuation_token","r":[{"i":8,"c":"release/api.v2:ready"}],"q":"api.v2:ready","x":[{"i":8,"s":0}]}
{"n":"identifier_case_fold","r":[{"i":9,"c":"Failure ERR_AUTH42 occurred"}],"q":"err_auth42","x":[{"i":9,"s":0.0761904761904762}]}
{"n":"literal_probe_adds_candidate","r":[{"i":10,"c":"moss"},{"i":11,"c":"TS2024","at":5},{"i":12,"c":"unrelated"}],"q":"moss","p":["TS2024"],"x":[{"i":10,"s":0.6857142857142857},{"i":11,"s":0.019972260748959775}]}
{"n":"literal_probe_uses_discrimination_weight","r":[{"i":13,"c":"moss"},{"i":14,"c":"ERR_CACHE"},{"i":15,"c":"ERR_CACHE extra"},{"i":16,"c":"nothing"}],"q":"moss","p":["ERR_CACHE"],"x":[{"i":13,"s":0.6857142857142857},{"i":14,"s":0.013445378151260505},{"i":15,"s":0.0022408963585434176}]}
{"n":"probe_duplicate_note_fuses_once","r":[{"i":17,"c":"ERR_CACHE"}],"q":"ERR_CACHE","p":["ERR_CACHE","err_cache"],"x":[{"i":17,"s":0.6857142857142857}]}
{"n":"tie_break_newest_then_lowest_id","r":[{"i":22,"c":"alpha beta","at":100},{"i":20,"c":"alpha beta","at":100},{"i":19,"c":"alpha beta","at":200}],"q":"alpha beta","x":[{"i":19,"s":0.8},{"i":20,"s":0.8},{"i":22,"s":0.8}]}
{"n":"date_bounds_are_inclusive","r":[{"i":30,"c":"alpha beta","at":99},{"i":31,"c":"alpha beta","at":100},{"i":32,"c":"alpha beta","at":200},{"i":33,"c":"alpha beta","at":201}],"q":"alpha beta","d":{"from":100,"to":200},"x":[{"i":32,"s":0.8},{"i":31,"s":0.8}]}
{"n":"date_range_excludes_every_row","r":[{"i":34,"c":"alpha beta","at":99}],"q":"alpha beta","d":{"from":100,"to":200},"x":[]}
{"n":"wrong_session_and_project_excluded","r":[{"i":35,"c":"alpha beta","sid":"other"},{"i":36,"c":"alpha beta","t":"smart","path":"/other"}],"q":"alpha beta","x":[]}
{"n":"active_session_note","r":[{"i":37,"c":"alpha beta"}],"q":"alpha beta","x":[{"i":37,"s":0.8}]}
{"n":"ready_smart_reason_only","r":[{"i":38,"c":"instruction text","t":"smart","s":"ready","rr":"alpha beta"}],"q":"alpha beta","x":[{"i":38,"s":0.5942857142857143}]}
{"n":"limit_applied_after_sort","r":[{"i":39,"c":"alpha beta","at":1},{"i":40,"c":"alpha beta","at":3},{"i":41,"c":"alpha beta","at":2}],"q":"alpha beta","l":2,"x":[{"i":40,"s":0.8},{"i":41,"s":0.8}]}
{"n":"blank_query_has_no_results","r":[{"i":42,"c":"alpha beta"}],"q":"  \t ","x":[]}
{"n":"empty_probe_does_not_change_base","r":[{"i":43,"c":"alpha beta"}],"q":"alpha beta","p":["  "],"x":[{"i":43,"s":0.8}]}
{"n":"ready_reason_trimmed","r":[{"i":44,"c":"instruction","t":"smart","s":"ready","rr":" \talpha beta\n"}],"q":"alpha beta","x":[{"i":44,"s":0.6285714285714286}]}
{"n":"content_and_reason_both_contribute_density","r":[{"i":45,"c":"alpha","t":"smart","s":"ready","rr":"beta gamma"}],"q":"alpha beta","x":[{"i":45,"s":0.17142857142857143}]}
{"n":"identifiers_with_slash_and_dashes","r":[{"i":46,"c":"module /repo-name/v2.1 is active"}],"q":"/repo-name/v2.1","x":[{"i":46,"s":0.05714285714285714}]}
{"n":"repeated_query_tokens_count_once","r":[{"i":47,"c":"alpha beta alpha"}],"q":"alpha alpha beta","x":[{"i":47,"s":0.34285714285714286}]}
{"n":"query_without_ascii_tokens_exact_match","r":[{"i":48,"c":"雪"}],"q":"雪","x":[{"i":48,"s":0.45714285714285713}]}
{"n":"probe_only_result_respects_limit","r":[{"i":49,"c":"moss"},{"i":50,"c":"ERR_X"}],"q":"moss","p":["ERR_X"],"l":1,"x":[{"i":49,"s":0.6857142857142857}]}
{"n":"smart_pending_reason_is_searchable","r":[{"i":51,"c":"instruction","t":"smart","s":"pending","rr":"alpha beta"}],"q":"alpha beta","x":[{"i":51,"s":0.6285714285714286}]}
{"n":"other_status_does_not_hide_active","r":[{"i":52,"c":"alpha beta","s":"dismissed"},{"i":53,"c":"alpha beta"}],"q":"alpha beta","x":[{"i":53,"s":0.8}]}
{"n":"no_keyword_match","r":[{"i":54,"c":"charlie delta"}],"q":"alpha beta","x":[]}
{"n":"scope_and_date_filter_before_probe_weight","r":[{"i":55,"c":"ERR_X","at":10},{"i":56,"c":"ERR_X","at":500},{"i":57,"c":"ERR_X","sid":"other","at":10},{"i":58,"c":"moss","at":10}],"q":"moss","p":["ERR_X"],"d":{"from":0,"to":100},"x":[{"i":58,"s":0.6857142857142857},{"i":55,"s":0.013445378151260505}]}
{"n":"generated_case_01","r":[{"i":100,"c":"needle0 marker0 tail"},{"i":101,"c":"prefix needle0 extra token0","s":"ready"}],"q":"needle0","p":["marker0"],"d":{"from":100,"to":101},"l":1,"x":[]}
{"n":"generated_case_02","r":[{"i":102,"c":"needle1 marker1 tail"},{"i":103,"c":"prefix needle1 extra token1","t":"smart","s":"pending","rr":"related needle1"}],"q":"needle1","x":[{"i":102,"s":0.0761904761904762},{"i":103,"s":0.0380952380952381}]}
{"n":"generated_case_03","r":[{"i":104,"c":"needle2 marker2 tail"},{"i":105,"c":"prefix needle2 extra token2"}],"q":"needle2","x":[{"i":104,"s":0.0761904761904762},{"i":105,"s":0.05714285714285714}]}
{"n":"generated_case_04","r":[{"i":106,"c":"needle3 marker3 tail"},{"i":107,"c":"prefix needle3 extra token3","t":"smart","s":"ready","rr":"related needle3"}],"q":"needle3","l":1,"x":[{"i":106,"s":0.0761904761904762}]}
{"n":"generated_case_05","r":[{"i":108,"c":"needle4 marker4 tail"},{"i":109,"c":"prefix needle4 extra token4","s":"pending"}],"q":"needle4","p":["marker4"],"x":[{"i":108,"s":0.0761904761904762},{"i":109,"s":0.05714285714285714}]}
{"n":"generated_case_06","r":[{"i":110,"c":"needle5 marker5 tail"},{"i":111,"c":"prefix needle5 extra token5","t":"smart","rr":"related needle5"}],"q":"needle5","d":{"from":1100,"to":1101},"x":[]}
{"n":"generated_case_07","r":[{"i":112,"c":"needle6 marker6 tail"},{"i":113,"c":"prefix needle6 extra token6","s":"ready"}],"q":"needle6","l":1,"x":[{"i":112,"s":0.0761904761904762}]}
{"n":"generated_case_08","r":[{"i":114,"c":"needle7 marker7 tail"},{"i":115,"c":"prefix needle7 extra token7","t":"smart","s":"pending","rr":"related needle7"}],"q":"needle7","x":[{"i":114,"s":0.0761904761904762},{"i":115,"s":0.0380952380952381}]}
{"n":"generated_case_09","r":[{"i":116,"c":"needle8 marker8 tail"},{"i":117,"c":"prefix needle8 extra token8"}],"q":"needle8","p":["marker8"],"x":[{"i":116,"s":0.0761904761904762},{"i":117,"s":0.05714285714285714}]}
{"n":"generated_case_10","r":[{"i":118,"c":"needle9 marker9 tail"},{"i":119,"c":"prefix needle9 extra token9","t":"smart","s":"ready","rr":"related needle9"}],"q":"needle9","l":1,"x":[{"i":118,"s":0.0761904761904762}]}
{"n":"generated_case_11","r":[{"i":120,"c":"needle10 marker10 tail"},{"i":121,"c":"prefix needle10 extra token10","s":"pending"}],"q":"needle10","d":{"from":2100,"to":2101},"x":[]}
{"n":"generated_case_12","r":[{"i":122,"c":"needle11 marker11 tail"},{"i":123,"c":"prefix needle11 extra token11","t":"smart","rr":"related needle11"}],"q":"needle11","x":[{"i":122,"s":0.0761904761904762},{"i":123,"s":0.0380952380952381}]}
"###;

    #[derive(Debug, Deserialize)]
    struct FixtureCase {
        #[serde(rename = "n")]
        name: String,
        #[serde(rename = "r")]
        notes: Vec<FixtureNote>,
        #[serde(rename = "q")]
        query: String,
        #[serde(rename = "p", default)]
        probes: Vec<String>,
        #[serde(rename = "d")]
        dates: Option<FixtureDates>,
        #[serde(rename = "l", default = "default_limit")]
        limit: usize,
        #[serde(rename = "x")]
        expected: Vec<FixtureHit>,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureNote {
        #[serde(rename = "i")]
        id: i64,
        #[serde(rename = "c")]
        content: String,
        #[serde(rename = "t", default = "default_note_type")]
        note_type: String,
        #[serde(rename = "s", default = "default_status")]
        status: String,
        #[serde(rename = "sid")]
        session_id: Option<String>,
        #[serde(rename = "path")]
        project_path: Option<String>,
        #[serde(rename = "sc")]
        surface_condition: Option<String>,
        #[serde(rename = "rr")]
        ready_reason: Option<String>,
        #[serde(rename = "at")]
        created_at: Option<i64>,
        #[serde(rename = "a")]
        anchor_ordinal: Option<i64>,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureDates {
        from: i64,
        to: i64,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureHit {
        #[serde(rename = "i")]
        note_id: i64,
        #[serde(rename = "s")]
        score: f64,
    }

    fn default_limit() -> usize {
        10
    }

    fn default_note_type() -> String {
        "session".to_owned()
    }

    fn default_status() -> String {
        "active".to_owned()
    }

    fn fixture_cases() -> Vec<FixtureCase> {
        TS_FIXTURE
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("valid TypeScript fixture row"))
            .collect()
    }

    fn fixture_case(name: &str) -> FixtureCase {
        fixture_cases()
            .into_iter()
            .find(|case| case.name == name)
            .unwrap_or_else(|| panic!("missing fixture case: {name}"))
    }

    fn run_fixture_case(case: &FixtureCase) -> Vec<NoteHit> {
        let notes: Vec<_> = case
            .notes
            .iter()
            .map(|row| {
                let note_type = match row.note_type.as_str() {
                    "session" => NoteType::Session,
                    "smart" => NoteType::Smart,
                    other => panic!("unknown fixture note type: {other}"),
                };
                let status = match row.status.as_str() {
                    "active" => NoteStatus::Active,
                    "pending" => NoteStatus::Pending,
                    "ready" => NoteStatus::Ready,
                    "dismissed" => NoteStatus::Dismissed,
                    other => panic!("unknown fixture note status: {other}"),
                };
                NoteRow {
                    id: row.id,
                    note_type,
                    status,
                    content: row.content.clone(),
                    session_id: row.session_id.clone().or_else(|| {
                        (note_type == NoteType::Session).then(|| "session-A".to_owned())
                    }),
                    project_path: row.project_path.clone().or_else(|| {
                        (note_type == NoteType::Smart).then(|| "/project-A".to_owned())
                    }),
                    surface_condition: row.surface_condition.clone(),
                    ready_reason: row.ready_reason.clone(),
                    created_at: row.created_at.unwrap_or(row.id * 100),
                    anchor_ordinal: row.anchor_ordinal.or(Some(row.id)),
                }
            })
            .collect();
        let dates = case
            .dates
            .as_ref()
            .map_or_else(DateBounds::default, |bounds| DateBounds {
                from_ms: Some(bounds.from),
                to_ms: Some(bounds.to),
            });
        rank_notes(
            &notes,
            "session-A",
            "/project-A",
            &case.query,
            &case.probes,
            dates,
            case.limit,
        )
    }

    fn assert_matches_fixture(case: &FixtureCase, hits: &[NoteHit]) {
        assert_eq!(
            hits.len(),
            case.expected.len(),
            "{} result count",
            case.name
        );
        for (actual, expected) in hits.iter().zip(&case.expected) {
            assert_eq!(actual.note_id, expected.note_id, "{} order", case.name);
            assert_eq!(
                actual.score.to_bits(),
                expected.score.to_bits(),
                "{} score for note {}",
                case.name,
                expected.note_id
            );
        }
    }

    #[test]
    fn ts_generated_fixture_matches_exact_order_and_f64_scores() {
        let cases = fixture_cases();
        assert!(cases.len() >= 30, "fixture has only {} cases", cases.len());
        for case in &cases {
            let hits = run_fixture_case(case);
            assert_matches_fixture(case, &hits);
        }
    }

    #[test]
    fn continuous_keyword_score_is_not_rounded() {
        let case = fixture_case("plain_fractional_density");
        let hits = run_fixture_case(&case);
        assert_matches_fixture(&case, &hits);
        assert_ne!((hits[0].score * 100.0).fract(), 0.0);
    }

    #[test]
    fn ready_reason_is_searched_instead_of_surface_condition() {
        let case = fixture_case("ready_reason_searches_not_surface_condition");
        let hits = run_fixture_case(&case);
        assert_matches_fixture(&case, &hits);
        assert_eq!(hits[0].status, NoteStatus::Ready);
        assert_eq!(hits[0].source_session_id, None);
        assert_eq!(
            hits[0].content,
            "the stored instruction Reason: alpha beta applies"
        );
    }

    #[test]
    fn literal_probe_fusion_keeps_probe_only_note_hits() {
        let case = fixture_case("literal_probe_adds_candidate");
        let hits = run_fixture_case(&case);
        assert_matches_fixture(&case, &hits);
        assert_eq!(
            hits.iter().map(|hit| hit.note_id).collect::<Vec<_>>(),
            [10, 11]
        );
    }

    #[test]
    fn equal_scores_tie_break_by_newest_then_lowest_note_id() {
        let case = fixture_case("tie_break_newest_then_lowest_id");
        let hits = run_fixture_case(&case);
        assert_matches_fixture(&case, &hits);
        assert_eq!(
            hits.iter().map(|hit| hit.note_id).collect::<Vec<_>>(),
            [19, 20, 22]
        );
    }
}
