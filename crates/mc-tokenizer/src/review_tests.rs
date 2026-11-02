//! Eviction of the history render cache under concurrent use, with a budget small
//! enough that every round evicts. Each thread follows the production protocol of
//! `count_render_piece`: look up under the lock, count outside it on a miss, insert
//! under the lock. Every answer must be the encoder's count, and the cache's byte and
//! recency accounting must stay exact however lookups, inserts and evictions interleave.

use super::*;

#[test]
fn render_cache_eviction_stays_exact_under_concurrent_lookups_and_inserts() {
    const BUDGET: usize = 6 * 1024;
    let cache = std::sync::Mutex::new(HistoryCounts::default());
    let texts: Vec<String> = (0..120)
        .map(|index| format!("## t{index}\n{}é🙂\n\n", "ab cd ".repeat(5 + index % 40)))
        .collect();
    let expected: Vec<[usize; 2]> = texts
        .iter()
        .map(|text| [count_piece(text, false), count_piece(text, true)])
        .collect();
    std::thread::scope(|scope| {
        for worker in 0..8usize {
            let (cache, texts, expected) = (&cache, &texts, &expected);
            scope.spawn(move || {
                let mut state = 0x9e37_79b9_u64 + worker as u64;
                for _ in 0..4_000 {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    let index = (state % texts.len() as u64) as usize;
                    let continued = state & (1 << 40) != 0;
                    let text = &texts[index];
                    let found = cache.lock().unwrap().lookup(text, continued);
                    let count = match found {
                        Some(count) => count,
                        None => {
                            let count = count_piece(text, continued);
                            cache
                                .lock()
                                .unwrap()
                                .insert_counted(text, continued, count, BUDGET);
                            count
                        }
                    };
                    assert_eq!(count, expected[index][usize::from(continued)]);
                    let cache = cache.lock().unwrap();
                    assert!(cache.bytes <= BUDGET);
                    assert_eq!(cache.entries.len(), cache.age.len());
                }
            });
        }
    });
    let cache = cache.into_inner().unwrap();
    assert_eq!(
        cache.bytes,
        cache
            .entries
            .keys()
            .map(|key| history_entry_cost(key.len()))
            .sum::<usize>()
    );
    for (age, key) in &cache.age {
        assert_eq!(cache.entries[&**key].age, *age);
    }
}
