//! The history render count cache must return exactly what `estimate_tokens` and the
//! ordinary encoder return, for every text, cold or cached, from any thread.
//!
//! The texts are randomized around the cache's piece split (`\n\n## `): headings at
//! the start and end, runs of newlines and carriage returns before a heading,
//! near-miss separators, empty pieces, multi-byte letters, combining marks, emoji
//! with joiners and digits. Several threads count overlapping texts at once, mixed
//! with the shared `estimate_tokens` cache, so lookups race inserts of the same text.

use mc_tokenizer::{
    encode_ordinary, estimate_history_render_tokens, estimate_tokens, history_paragraph_counts,
    history_render_paragraph_counts,
};

struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d) % n.max(1)
    }
}

const PIECES: &[&str] = &[
    "\n\n## ",
    "\n\n## ",
    "\n\n\n## ",
    "\r\n\r\n## ",
    "\n\n##",
    "\n\n#",
    "\n\n ## ",
    "\n \n## ",
    "\n\n",
    "\n",
    " ",
    "  ",
    "\t",
    "## ",
    "#",
    "word",
    "Fold",
    "can't",
    "we've",
    "42",
    "007",
    "日本語",
    "café",
    "e\u{301}",
    "🙂",
    "👩\u{200d}💻",
    "\u{a0}",
    "\u{2028}",
    "\u{3000}",
    "<EOT>",
    "x>y",
    ".",
    "-",
];

fn text(rng: &mut Rng) -> String {
    let mut out = String::new();
    for _ in 0..rng.below(40) {
        out.push_str(PIECES[rng.below(PIECES.len() as u64) as usize]);
    }
    out
}

fn check(text: &str) {
    let expected = encode_ordinary(text).len();
    assert_eq!(estimate_history_render_tokens(text), expected, "{text:?}");
    assert_eq!(estimate_tokens(text), expected, "{text:?}");
    assert_eq!(
        history_render_paragraph_counts(text),
        history_paragraph_counts(text),
        "{text:?}"
    );
}

#[test]
fn history_render_counts_equal_the_encoder_on_randomized_split_texts() {
    let mut rng = Rng(0x7e57);
    let texts: Vec<String> = (0..3_000).map(|_| text(&mut rng)).collect();
    // Cold, then again from the cache.
    for _ in 0..2 {
        for text in &texts {
            check(text);
        }
    }
    check("");
    assert_eq!(estimate_history_render_tokens(""), 0);
}

#[test]
fn history_render_counts_are_exact_under_concurrent_threads() {
    let mut rng = Rng(0xc0c0);
    let texts: Vec<String> = (0..600).map(|_| text(&mut rng)).collect();
    let expected: Vec<usize> = texts
        .iter()
        .map(|text| encode_ordinary(text).len())
        .collect();
    std::thread::scope(|scope| {
        for worker in 0..8u64 {
            let (texts, expected) = (&texts, &expected);
            scope.spawn(move || {
                let mut rng = Rng(0x1000 + worker);
                for _ in 0..3_000 {
                    let index = rng.below(texts.len() as u64) as usize;
                    let text = &texts[index];
                    let count = if rng.below(2) == 0 {
                        estimate_history_render_tokens(text)
                    } else {
                        estimate_tokens(text)
                    };
                    assert_eq!(count, expected[index], "{text:?}");
                }
            });
        }
    });
}
