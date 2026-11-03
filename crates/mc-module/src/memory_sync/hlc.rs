//! A clock is allocated in the same transaction as its immutable op bytes.
pub(super) fn next(now: i64, wall: i64, logical: i64) -> Option<(i64, i64)> {
    if now < 0 || wall < 0 || !(0..=u32::MAX as i64).contains(&logical) {
        return None;
    }
    if now > wall {
        Some((now, 0))
    } else if logical < u32::MAX as i64 {
        Some((wall, logical + 1))
    } else {
        wall.checked_add(1).map(|w| (w, 0))
    }
}
