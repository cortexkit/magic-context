//! SHA-256 resumed from a running state, as Engram's session door reports
//! it for a stream's trim floor.
//!
//! The door hashes every stream from byte 0, but keeps only the bytes from
//! the floor on. For the bytes before it, it reports the hash's running
//! state there (`midstate`): the 32-byte chaining value as eight
//! big-endian 32-bit words in lowercase hex, and the bytes after the last
//! full 64-byte block (`tail`, fewer than 64) in lowercase hex. Resuming
//! from that state with the floor as the count of bytes already hashed,
//! then feeding the bytes from the floor on, gives the SHA-256 of the whole
//! stream without reading its trimmed prefix.

use serde::Deserialize;
use sha2::digest::generic_array::GenericArray;

/// SHA-256's initial chaining value, the state of a stream with nothing
/// hashed yet.
const INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/// The running state as the door encodes it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Midstate {
    pub chaining: String,
    pub tail: String,
}

/// A SHA-256 that can start from a running state.
#[derive(Clone, Debug)]
pub struct Resumed {
    state: [u32; 8],
    /// Bytes waiting for a full block, always fewer than 64.
    tail: Vec<u8>,
    /// Every byte hashed so far, the tail included.
    count: u64,
}

impl Default for Resumed {
    fn default() -> Self {
        Self {
            state: INITIAL,
            tail: Vec::new(),
            count: 0,
        }
    }
}

impl Resumed {
    /// Resume from `midstate` after `floor` bytes. The tail must hold
    /// exactly the bytes past the floor's last full block, or the state
    /// does not describe that many bytes.
    pub fn from_midstate(midstate: &Midstate, floor: u64) -> Result<Self, String> {
        let chaining = super::door::unhex(&midstate.chaining)
            .filter(|bytes| bytes.len() == 32)
            .ok_or("the midstate's chaining value is not 32 bytes of hex")?;
        let tail = super::door::unhex(&midstate.tail)
            .filter(|bytes| bytes.len() < 64)
            .ok_or("the midstate's tail is not fewer than 64 bytes of hex")?;
        if tail.len() as u64 != floor % 64 {
            return Err(format!(
                "the midstate's tail holds {} bytes, but a floor of {floor} leaves {}",
                tail.len(),
                floor % 64
            ));
        }
        let mut state = [0; 8];
        for (word, bytes) in state.iter_mut().zip(chaining.chunks(4)) {
            *word = u32::from_be_bytes(bytes.try_into().expect("four bytes"));
        }
        Ok(Self {
            state,
            tail,
            count: floor,
        })
    }

    /// The running state now, encoded as the door encodes it.
    pub fn midstate(&self) -> Midstate {
        let chaining: Vec<u8> = self
            .state
            .iter()
            .flat_map(|word| word.to_be_bytes())
            .collect();
        Midstate {
            chaining: super::door::hex(&chaining),
            tail: super::door::hex(&self.tail),
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.count += bytes.len() as u64;
        self.absorb(bytes);
    }

    /// The digest in lowercase hex: SHA-256's padding, a 0x80 byte, zeros
    /// until the block holds 56 bytes, and the count of hashed bits as a
    /// big-endian 64-bit number, then the chaining value as eight
    /// big-endian words.
    pub fn finish(mut self) -> String {
        let zeros = (64 + 56 - (self.tail.len() + 1) % 64) % 64;
        let mut padding = vec![0x80];
        padding.resize(1 + zeros, 0);
        padding.extend_from_slice(&self.count.wrapping_mul(8).to_be_bytes());
        self.absorb(&padding);
        debug_assert!(self.tail.is_empty());
        let digest: Vec<u8> = self
            .state
            .iter()
            .flat_map(|word| word.to_be_bytes())
            .collect();
        super::door::hex(&digest)
    }

    /// Fill the tail to a block and compress it, compress every whole block
    /// after it, and keep what is left as the new tail.
    fn absorb(&mut self, mut bytes: &[u8]) {
        if !self.tail.is_empty() {
            let take = (64 - self.tail.len()).min(bytes.len());
            self.tail.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.tail.len() < 64 {
                return;
            }
            let block = std::mem::take(&mut self.tail);
            self.compress(&block);
        }
        let full = bytes.len() - bytes.len() % 64;
        self.compress(&bytes[..full]);
        self.tail.extend_from_slice(&bytes[full..]);
    }

    /// Run the compression function over whole 64-byte blocks.
    fn compress(&mut self, blocks: &[u8]) {
        debug_assert!(blocks.len().is_multiple_of(64));
        for block in blocks.chunks(64) {
            sha2::compress256(
                &mut self.state,
                std::slice::from_ref(GenericArray::from_slice(block)),
            );
        }
    }
}
