//! Lossless JSON ropes over a session-owned byte arena. Tokens, including string
//! contents, have one owned byte range; documents own only integer references.
use std::collections::HashMap;
use std::mem::size_of;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Document(pub u32);

struct Token {
    start: u32,
    len: u8,
    capacity: u8,
    references: u32,
    hash: u64,
}

struct JsonDocument {
    tokens: Vec<u32>,
    references: u32,
    hash: u64,
    len: usize,
}

#[derive(Default)]
pub struct ByteArena {
    bytes: Vec<u8>,
    tokens: Vec<Option<Token>>,
    vacant_tokens: Vec<u32>,
    free_bytes: Vec<Vec<u32>>,
    token_index: HashMap<u64, Vec<u32>>,
    documents: Vec<Option<JsonDocument>>,
    vacant_documents: Vec<u32>,
    document_index: HashMap<u64, Vec<u32>>,
}

fn hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hash);
    hash.finish()
}

impl ByteArena {
    fn token(&mut self, bytes: &[u8]) -> u32 {
        let hash = hash(bytes);
        if let Some(found) = self
            .token_index
            .get(&hash)
            .and_then(|indices| {
                indices.iter().find(|&&index| {
                    let token = self.tokens[index as usize].as_ref().unwrap();
                    &self.bytes[token.start as usize..token.start as usize + usize::from(token.len)]
                        == bytes
                })
            })
            .copied()
        {
            self.tokens[found as usize].as_mut().unwrap().references += 1;
            return found;
        }
        if self.free_bytes.is_empty() {
            self.free_bytes.resize_with(65, Vec::new);
        }
        let free = (bytes.len()..=64).find_map(|capacity| {
            self.free_bytes[capacity]
                .pop()
                .map(|start| (start, capacity))
        });
        let (start, capacity) = if let Some((start, capacity)) = free {
            self.bytes[start as usize..start as usize + bytes.len()].copy_from_slice(bytes);
            (start, capacity)
        } else {
            let start = u32::try_from(self.bytes.len()).expect("bounded resident byte arena");
            self.bytes.extend_from_slice(bytes);
            (start, bytes.len())
        };
        let token = Token {
            start,
            len: bytes.len() as u8,
            capacity: capacity as u8,
            references: 1,
            hash,
        };
        let index = if let Some(index) = self.vacant_tokens.pop() {
            self.tokens[index as usize] = Some(token);
            index
        } else {
            let index = self.tokens.len() as u32;
            self.tokens.push(Some(token));
            index
        };
        let bucket = self.token_index.entry(hash).or_default();
        bucket.push(index);
        bucket.shrink_to_fit();
        index
    }

    fn release_token(&mut self, index: u32) {
        let token = self.tokens[index as usize].as_mut().unwrap();
        token.references -= 1;
        if token.references != 0 {
            return;
        }
        let token = self.tokens[index as usize].take().unwrap();
        let indices = self.token_index.get_mut(&token.hash).unwrap();
        indices.retain(|&held| held != index);
        if indices.is_empty() {
            self.token_index.remove(&token.hash);
        }
        self.free_bytes[token.capacity as usize].push(token.start);
        self.vacant_tokens.push(index);
    }

    pub fn insert(&mut self, bytes: &[u8]) -> Document {
        let hash = hash(bytes);
        if let Some(index) = self
            .document_index
            .get(&hash)
            .and_then(|indices| {
                indices
                    .iter()
                    .find(|&&index| self.equals(Document(index), bytes))
            })
            .copied()
        {
            self.documents[index as usize].as_mut().unwrap().references += 1;
            return Document(index);
        }
        // Delimiters are split independently of position, so adding a tag or a
        // reminder does not copy the unchanged words following that addition.
        let delimiter =
            |byte: u8| byte.is_ascii_whitespace() || b"{}[],:\"\\()<>-/.;#*=|+!?@".contains(&byte);
        let mut tokens = Vec::new();
        let mut start = 0;
        while start < bytes.len() {
            let end = if bytes[start] == b'\\' && start + 1 < bytes.len() {
                start + 2
            } else if delimiter(bytes[start]) {
                start + 1
            } else {
                let mut end = start + 1;
                while end < bytes.len() && end - start < 64 && !delimiter(bytes[end]) {
                    end += 1;
                }
                end
            };
            tokens.push(self.token(&bytes[start..end]));
            start = end;
        }
        tokens.shrink_to_fit();
        let document = JsonDocument {
            tokens,
            references: 1,
            hash,
            len: bytes.len(),
        };
        let index = if let Some(index) = self.vacant_documents.pop() {
            self.documents[index as usize] = Some(document);
            index
        } else {
            let index = self.documents.len() as u32;
            self.documents.push(Some(document));
            index
        };
        let bucket = self.document_index.entry(hash).or_default();
        bucket.push(index);
        bucket.shrink_to_fit();
        Document(index)
    }

    pub fn release(&mut self, document: Document) {
        let stored = self.documents[document.0 as usize].as_mut().unwrap();
        stored.references -= 1;
        if stored.references != 0 {
            return;
        }
        let stored = self.documents[document.0 as usize].take().unwrap();
        for token in stored.tokens {
            self.release_token(token);
        }
        let indices = self.document_index.get_mut(&stored.hash).unwrap();
        indices.retain(|&index| index != document.0);
        if indices.is_empty() {
            self.document_index.remove(&stored.hash);
        }
        self.vacant_documents.push(document.0);
    }

    pub fn equals(&self, document: Document, bytes: &[u8]) -> bool {
        let document = self.documents[document.0 as usize].as_ref().unwrap();
        if document.len != bytes.len() {
            return false;
        }
        let mut offset = 0;
        for &index in &document.tokens {
            let token = self.tokens[index as usize].as_ref().unwrap();
            let size = usize::from(token.len);
            if self.bytes[token.start as usize..token.start as usize + size]
                != bytes[offset..offset + size]
            {
                return false;
            }
            offset += size;
        }
        true
    }

    pub fn bytes(&self, document: Document) -> Vec<u8> {
        let document = self.documents[document.0 as usize].as_ref().unwrap();
        let mut out = Vec::with_capacity(document.len);
        for &index in &document.tokens {
            let token = self.tokens[index as usize].as_ref().unwrap();
            out.extend_from_slice(
                &self.bytes[token.start as usize..token.start as usize + usize::from(token.len)],
            );
        }
        out
    }

    pub fn retained_bytes(&self) -> usize {
        use crate::retained_size::hash_map_allocation_bytes;
        size_of::<Self>()
            + self.bytes.capacity()
            + self.tokens.capacity() * size_of::<Option<Token>>()
            + self.vacant_tokens.capacity() * size_of::<u32>()
            + self.documents.capacity() * size_of::<Option<JsonDocument>>()
            + self
                .documents
                .iter()
                .flatten()
                .map(|document| document.tokens.capacity() * size_of::<u32>())
                .sum::<usize>()
            + self.vacant_documents.capacity() * size_of::<u32>()
            + self.free_bytes.capacity() * size_of::<Vec<u32>>()
            + self
                .free_bytes
                .iter()
                .map(|free| free.capacity() * size_of::<u32>())
                .sum::<usize>()
            + hash_map_allocation_bytes(&self.token_index)
            + hash_map_allocation_bytes(&self.document_index)
            + self
                .token_index
                .values()
                .chain(self.document_index.values())
                .map(|indices| indices.capacity() * size_of::<u32>())
                .sum::<usize>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_documents_share_bytes_and_keep_unicode_and_escapes_exact() {
        let mut arena = ByteArena::default();
        let raw = br#"{"text":"source \\n caf\u00e9","number":9007199254740993}"#;
        let first = arena.insert(raw);
        let duplicate = arena.insert(raw);
        assert_eq!(first, duplicate);
        assert_eq!(arena.bytes(first), raw);
        assert!(arena.equals(first, raw));
        assert!(!arena.equals(first, br#"{"text":"stale"}"#));
        arena.release(first);
        assert_eq!(arena.bytes(duplicate), raw);
        arena.release(duplicate);
        let unicode = "{\"text\":\"café 🦀 [mc:123] source\"}";
        let next = arena.insert(unicode.as_bytes());
        assert_eq!(arena.bytes(next), unicode.as_bytes());
    }

    #[test]
    fn arena_token_index_verifies_bytes_even_when_hash_bucket_collides() {
        let mut arena = ByteArena::default();
        let first = arena.token(b"first");
        arena.token_index.insert(hash(b"other"), vec![first]);
        let other = arena.token(b"other");
        assert_ne!(first, other);
        let token = arena.tokens[other as usize].as_ref().unwrap();
        assert_eq!(
            &arena.bytes[token.start as usize..token.start as usize + usize::from(token.len)],
            b"other"
        );
    }

    #[test]
    fn arena_document_index_verifies_the_complete_document_on_collision() {
        let mut arena = ByteArena::default();
        let first = arena.insert(br#"{"value":"before"}"#);
        arena
            .document_index
            .insert(hash(br#"{"value":"after"}"#), vec![first.0]);
        let after = arena.insert(br#"{"value":"after"}"#);
        assert_ne!(first, after);
        assert_eq!(arena.bytes(after), br#"{"value":"after"}"#);
    }

    #[test]
    fn released_documents_reuse_slots_and_do_not_grow_with_session_age() {
        let mut arena = ByteArena::default();
        let mut current = arena.insert(br#"{"value":"turn-000000"}"#);
        for step in 0..1000 {
            let next = arena.insert(format!("{{\"value\":\"turn-{step:06}\"}}").as_bytes());
            arena.release(current);
            current = next;
        }
        let initial = arena.retained_bytes();
        for step in 1000..10000 {
            let bytes = format!("{{\"value\":\"turn-{step:06}\"}}");
            let next = arena.insert(bytes.as_bytes());
            arena.release(current);
            current = next;
            assert_eq!(arena.bytes(current), bytes.as_bytes());
        }
        assert_eq!(arena.retained_bytes(), initial);
    }
}
