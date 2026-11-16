//! The mural leaves out the cues its font can't draw.

use super::*;
use crate::context_db::ContextDb;

/// A fresh store whose project `pj-mural` holds one memory per `(category,
/// cue)` in `pool`, each with a current cue, and those memories as the head
/// reads them. Ids start at 1, in pool order.
fn store(pool: &[(&str, &str)]) -> (tempfile::TempDir, ContextDb, Vec<StoredMemory>) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let memories = pool
        .iter()
        .zip(1_i64..)
        .map(|((category, cue), id)| {
            let content = format!("memory {id}: the full text behind its cue");
            db.with_connection(|conn| {
                conn.execute(
                    "INSERT INTO memories (id, level, owner_id, category, origin_category, content, normalized_hash, status, importance,
                     first_seen_at, created_at, updated_at, last_seen_at, mural_cue, mural_cue_hash)
                     VALUES (?1, 'project', 'pj-mural', 'swe:naming', ?2, ?3, ?4, 'active', 50, 1, 1, 1, 1, ?5, ?6)",
                    params![id, category, content, format!("h{id}"), cue, content_hash(&content)],
                )
                .unwrap()
            });
            StoredMemory {
                id,
                project_path: "pj-mural".into(),
                category: (*category).into(),
                content,
                importance: Some(50),
                status: "active".into(),
                ..StoredMemory::default()
            }
        })
        .collect();
    (dir, db, memories)
}

fn every_id(memories: &[StoredMemory]) -> HashSet<i64> {
    memories.iter().map(|memory| memory.id).collect()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A pool whose every cue the font draws: ASCII and the symbols the cue
/// compressor is asked for, the em dash among them.
const DRAWN_TODAY: [(&str, &str); 9] = [
    ("PROJECT_RULES", "⊘force push (rewrites shared history)"),
    ("PROJECT_RULES", "gate → preflight → deliver"),
    ("ARCHITECTURE", "m[0] baseline — m[1] delta ← fold"),
    ("ARCHITECTURE", "∀ lanes: one bust permission ∵ split bust"),
    ("CONSTRAINTS", "∅ live stores in tests"),
    ("CONFIG_VALUES", "execute_threshold_percentage=65"),
    ("NAMING", "ck-mc ≺ subc ≻ runner"),
    (
        "NAMING",
        "crates/mc-module/src/mural/render.rs — layout + raster, a cue long enough to wrap",
    ),
    (
        "LEGACY_CATEGORY",
        "plain ASCII: {braces} [brackets] ~tilde `tick` |pipe| \\back \"quoted\" 'single'",
    ),
];

/// A mural whose every cue the font draws keeps the exact PNG bytes it had
/// before cues the font can't draw were left out, so a session's next fold
/// serves the same image. The digests were taken from the renderer as it
/// was before that change.
#[test]
fn a_mural_the_font_draws_whole_keeps_its_bytes() {
    let (_dir, db, memories) = store(&DRAWN_TODAY);
    let mural = db
        .with_connection(|conn| ensure(conn, "pj-mural", &memories, &every_id(&memories), 1))
        .unwrap()
        .expect("a mural");
    assert_eq!(mural.memory_ids.len(), DRAWN_TODAY.len());
    assert_eq!(
        (
            sha256(&mural.png),
            mural.content_hash,
            mural.width,
            mural.height
        ),
        (
            "e82868737cd6e756cbc5a2673ced1c5114677ecbc1267fc426e35c4ac9dcbe85".to_owned(),
            "b72723389299fa1ae4bb25a9aa9c8e8cd0c2d25fc3827b50421ce1553c268763".to_owned(),
            364,
            168
        )
    );
    for (_, cue) in DRAWN_TODAY {
        assert_eq!(render::drawable_cue(cue).as_deref(), Some(cue), "{cue}");
    }
}

/// A pool of Chinese cues gives no mural: the font draws none of them, so
/// none counts towards the cues a mural needs, and no image is stored.
#[test]
fn a_pool_of_chinese_cues_gives_no_mural() {
    let pool: Vec<(&str, &str)> = (0..20)
        .map(|index| {
            (
                ["PROJECT_RULES", "ARCHITECTURE", "NAMING"][index % 3],
                "提交前运行门禁 → 发布",
            )
        })
        .collect();
    let (_dir, db, memories) = store(&pool);
    let mural = db
        .with_connection(|conn| ensure(conn, "pj-mural", &memories, &every_id(&memories), 1))
        .unwrap();
    assert_eq!(mural, None);
    let stored: i64 = db.with_connection(|conn| {
        conn.query_row("SELECT count(*) FROM mural_manifest", [], |row| row.get(0))
            .unwrap()
    });
    assert_eq!(stored, 0);
}

/// Enough drawable cues elsewhere in the pool, but none among the memories
/// the head left out: there is nothing to draw, so there is no mural.
#[test]
fn no_mural_when_the_font_draws_none_of_the_left_out_cues() {
    let mut pool = vec![("NAMING", "ck-mc → module"); 20];
    pool.extend([("CONSTRAINTS", "不要打开实时存储"); 3]);
    let (_dir, db, memories) = store(&pool);
    let left_out: HashSet<i64> = (21..=23).collect();
    let mural = db
        .with_connection(|conn| ensure(conn, "pj-mural", &memories, &left_out, 1))
        .unwrap();
    assert_eq!(mural, None);
}

/// A mixed pool draws only the cues the font can draw, exactly as a pool
/// without the others would, and a category whose cues are all left out
/// loses its banner too. The layout lists what it left out and why.
#[test]
fn a_mixed_pool_draws_only_the_drawable_cues() {
    let mixed = [
        ("PROJECT_RULES", "gate → preflight → deliver"),
        ("PROJECT_RULES", "提交前运行门禁"),
        ("ARCHITECTURE", "m[0] baseline — m[1] delta"),
        ("CONSTRAINTS", "不要打开实时存储"),
        ("CONSTRAINTS", "⊘提交密钥 (泄露)"),
        ("NAMING", "ck-mc ≺ subc"),
    ];
    let (_dir, db, memories) = store(&mixed);
    let all = every_id(&memories);
    let (drawn, plan) = db.with_connection(|conn| {
        let drawn = ensure(conn, "pj-mural", &memories, &all, 1).unwrap();
        let cues = read_cues(conn, &all.iter().copied().collect::<Vec<_>>()).unwrap();
        (drawn, render::plan(&entries(&memories, &cues, &all)))
    });
    let drawn = drawn.expect("a mural of the drawable cues");
    assert_eq!(drawn.memory_ids, [1, 3, 6]);
    assert_eq!(
        (plan.rendered_ids, plan.dropped_ids, plan.undrawable_ids),
        (vec![1, 3, 6], vec![], vec![2, 4, 5])
    );
    assert!(!plan.text.contains("<CONSTRAINTS>"), "{}", plan.text);

    let drawable_only = [mixed[0], mixed[2], mixed[5]];
    let (_dir, db, memories) = store(&drawable_only);
    let alone = db
        .with_connection(|conn| ensure(conn, "pj-mural", &memories, &every_id(&memories), 1))
        .unwrap()
        .expect("a mural");
    assert_eq!(
        (drawn.content_hash, sha256(&drawn.png)),
        (alone.content_hash, sha256(&alone.png))
    );
}

/// Only a cue the font can draw counts towards the cues a mural needs: 40
/// Chinese cues and 2 drawable ones give no mural, and the same pool with
/// 15 drawable ones gives one of those 15.
#[test]
fn only_drawable_cues_count_towards_a_mural() {
    let pool = |drawable: usize| -> Vec<(&str, &str)> {
        let mut pool = vec![("NAMING", "提交前运行门禁"); 40];
        pool.extend(vec![("NAMING", "ck-mc → module"); drawable]);
        pool
    };
    let (_dir, db, memories) = store(&pool(2));
    let mural = db
        .with_connection(|conn| ensure(conn, "pj-mural", &memories, &every_id(&memories), 1))
        .unwrap();
    assert_eq!(mural, None);

    let (_dir, db, memories) = store(&pool(15));
    let mural = db
        .with_connection(|conn| ensure(conn, "pj-mural", &memories, &every_id(&memories), 1))
        .unwrap()
        .expect("a mural");
    assert_eq!(mural.memory_ids, (41..=55).collect::<Vec<i64>>());
}

/// An accented letter, a ligature, a full-width letter and typographic
/// punctuation the font lacks are drawn as the ASCII they stand for, so
/// their cue is drawn, pixel for pixel as its ASCII spelling.
#[test]
fn accents_and_typographic_punctuation_are_drawn_as_ascii() {
    let entry = |cue: &str| render::Entry {
        id: 1,
        category: "NAMING".into(),
        importance: 50,
        cue: cue.into(),
    };
    let rescued = render::plan(&[entry(
        "café “naïve” – résume\u{301}… ‘ok’ „nein“ ﬁle Ｗide ‐x",
    )]);
    let ascii = render::plan(&[entry(
        "cafe \"naive\" - resume... 'ok' \"nein\" file Wide -x",
    )]);
    assert_eq!(rescued.undrawable_ids, Vec::<i64>::new());
    assert_eq!(rescued.text, ascii.text);
    assert_eq!(render::raster(&rescued), render::raster(&ascii));
}

/// A character the font draws is never rewritten, the em dash included,
/// and a negated symbol is not drawn as its opposite: `≠` decomposes to
/// `=` and an overlaid solidus, which stays, so its cue is left out.
#[test]
fn drawable_characters_stay_and_negations_are_not_inverted() {
    assert_eq!(
        render::drawable_cue("a — b → c ← d ⊘e (f) ∀ ∅ ∵ ≺ ≻ • ─ ▰").as_deref(),
        Some("a — b → c ← d ⊘e (f) ∀ ∅ ∵ ≺ ≻ • ─ ▰")
    );
    for negated in ["retry ≠ resend", "x ↛ y", "a ⊀ b", "a ≮ b", "a =\u{338} b"] {
        assert_eq!(render::drawable_cue(negated), None, "{negated}");
    }
    // A cue whose every character the font lacks, or that only combining
    // marks make up, is not drawn; a blank cue is drawn as today.
    assert_eq!(render::drawable_cue("rocket 🚀"), None);
    assert_eq!(render::drawable_cue("\u{301}\u{308}"), None);
    assert_eq!(render::drawable_cue("  ").as_deref(), Some("  "));
}
