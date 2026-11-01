//! A hasher whose output is fixed forever, for digests that are stored and compared
//! across module builds.
//!
//! `std::collections::hash_map::DefaultHasher` documents its algorithm as unspecified:
//! a later Rust release may change it. A digest written by one build and compared by the
//! next must not depend on that, because a changed digest reads as changed input. For the
//! m1 revisions that would make every session see an external revision change on the
//! first pass after a toolchain upgrade and force a cache-busting m0 rebuild everywhere.
//!
//! This is SipHash-1-3 with both keys zero, the algorithm `DefaultHasher::new()` uses
//! today, so every digest it produces equals the one already stored. Values are fed
//! through the standard `Hash` implementations exactly as before (a string writes its
//! bytes and then `0xff`, an integer its native-endian bytes); the tests pin both the
//! equivalence with today's `DefaultHasher` and literal digests, so a change on either
//! side fails a test instead of shipping.

use std::hash::Hasher;

/// SipHash-1-3 with zero keys: one compression round per 8-byte word and three
/// finalization rounds.
#[derive(Debug, Clone)]
pub(crate) struct StableSipHasher13 {
    v0: u64,
    v1: u64,
    v2: u64,
    v3: u64,
    /// Bytes not yet forming a full 8-byte word, little-endian in the low bits.
    tail: u64,
    /// How many bytes `tail` holds (0..8).
    tail_len: usize,
    /// Total bytes written. Only its low byte enters the final block.
    length: usize,
}

impl StableSipHasher13 {
    pub(crate) fn new() -> Self {
        Self {
            v0: 0x736f_6d65_7073_6575,
            v1: 0x646f_7261_6e64_6f6d,
            v2: 0x6c79_6765_6e65_7261,
            v3: 0x7465_6462_7974_6573,
            tail: 0,
            tail_len: 0,
            length: 0,
        }
    }

    #[inline]
    fn round(&mut self) {
        self.v0 = self.v0.wrapping_add(self.v1);
        self.v1 = self.v1.rotate_left(13);
        self.v1 ^= self.v0;
        self.v0 = self.v0.rotate_left(32);
        self.v2 = self.v2.wrapping_add(self.v3);
        self.v3 = self.v3.rotate_left(16);
        self.v3 ^= self.v2;
        self.v0 = self.v0.wrapping_add(self.v3);
        self.v3 = self.v3.rotate_left(21);
        self.v3 ^= self.v0;
        self.v2 = self.v2.wrapping_add(self.v1);
        self.v1 = self.v1.rotate_left(17);
        self.v1 ^= self.v2;
        self.v2 = self.v2.rotate_left(32);
    }

    #[inline]
    fn compress(&mut self, word: u64) {
        self.v3 ^= word;
        self.round();
        self.v0 ^= word;
    }
}

impl Default for StableSipHasher13 {
    fn default() -> Self {
        Self::new()
    }
}

impl Hasher for StableSipHasher13 {
    fn write(&mut self, bytes: &[u8]) {
        self.length = self.length.wrapping_add(bytes.len());
        for &byte in bytes {
            self.tail |= u64::from(byte) << (8 * self.tail_len);
            self.tail_len += 1;
            if self.tail_len == 8 {
                let word = self.tail;
                self.compress(word);
                self.tail = 0;
                self.tail_len = 0;
            }
        }
    }

    fn finish(&self) -> u64 {
        let mut state = self.clone();
        let last = ((self.length as u64 & 0xff) << 56) | self.tail;
        state.compress(last);
        state.v2 ^= 0xff;
        state.round();
        state.round();
        state.round();
        state.v0 ^ state.v1 ^ state.v2 ^ state.v3
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::Hash;

    fn both<T: Hash + ?Sized>(value: &T) -> (u64, u64) {
        let mut stable = StableSipHasher13::new();
        value.hash(&mut stable);
        let mut default = DefaultHasher::new();
        value.hash(&mut default);
        (stable.finish(), default.finish())
    }

    /// The pinned hasher gives today's `DefaultHasher` answer for every shape the stored
    /// digests feed it, so switching to it changes no stored revision.
    #[test]
    fn matches_the_default_hasher_digests_already_stored() {
        let lengths = (0..40).map(|n| "x".repeat(n)).collect::<Vec<_>>();
        for text in lengths.iter().map(String::as_str).chain([
            "mc-m1-rev-v1",
            "mc-m1-in-session-v2",
            "mc-m1-external-v2",
            "naïve ünïcode ✓",
        ]) {
            let (stable, default) = both(text);
            assert_eq!(stable, default, "{text:?}");
        }
        for number in [0i64, 1, -1, 42, i64::MIN, i64::MAX, 1_800_000_000_000] {
            let (stable, default) = both(&number);
            assert_eq!(stable, default, "{number}");
            let (stable, default) = both(&(number as u64));
            assert_eq!(stable, default, "{number} as u64");
            let (stable, default) = both(&Some(number));
            assert_eq!(stable, default, "Some({number})");
        }
        let (stable, default) = both(&None::<String>);
        assert_eq!(stable, default);

        // A stream of several values, the way each revision is built.
        fn feed<H: Hasher>(hasher: &mut H) -> u64 {
            "mc-m1-in-session-v2".hash(hasher);
            7i64.hash(hasher);
            Some("history".to_string()).hash(hasher);
            3u64.hash(hasher);
            hasher.finish()
        }
        assert_eq!(
            feed(&mut StableSipHasher13::new()),
            feed(&mut DefaultHasher::new())
        );
    }

    /// Literal digests, independent of the standard library: the reference SipHash-1-3
    /// test vector for the empty input with zero keys, and two m1 revision inputs.
    #[test]
    fn digests_are_pinned_to_literal_values() {
        assert_eq!(StableSipHasher13::new().finish(), 0xd1fb_a762_150c_532c);
        let mut hasher = StableSipHasher13::new();
        "mc-m1-rev-v1".hash(&mut hasher);
        5i64.hash(&mut hasher);
        2i64.hash(&mut hasher);
        9i64.hash(&mut hasher);
        assert_eq!(hasher.finish(), PINNED_V1_DIGEST);
    }

    /// The digest of `"mc-m1-rev-v1", 5i64, 2i64, 9i64` (a little-endian build), computed
    /// with an independent SipHash-1-3 implementation over the bytes the `Hash`
    /// implementations write.
    const PINNED_V1_DIGEST: u64 = 0x6f0e_ab2c_0cd5_6384;
}
