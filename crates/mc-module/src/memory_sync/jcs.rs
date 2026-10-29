//! Strict JSON admission before RFC 8785 canonicalization.
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::fmt;

struct Strict;

impl<'de> DeserializeSeed<'de> for Strict {
    type Value = Value;

    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Strict {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON with unique keys, scalar Unicode and bounded integers")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        if v.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(E::custom("integer out of range"));
        }
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        if v > 9_007_199_254_740_991 {
            return Err(E::custom("integer out of range"));
        }
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Value, E> {
        Err(E::custom("floats refused"))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(v) = seq.next_element_seed(Strict)? {
            values.push(v);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate key"));
            }
            values.insert(key, map.next_value_seed(Strict)?);
        }
        Ok(Value::Object(values))
    }
}

pub(super) fn canonicalize(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = serde_json::Deserializer::from_slice(raw);
    let value = Strict
        .deserialize(&mut decoder)
        .map_err(|e| e.to_string())?;
    decoder.end().map_err(|e| e.to_string())?;
    serde_jcs::to_vec(&value).map_err(|e| e.to_string())
}

pub(super) fn bytes(value: &Value) -> Result<Vec<u8>, String> {
    canonicalize(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

pub(super) fn digest(bytes: &[u8]) -> String {
    crate::digest::hex(&Sha256::digest(bytes))
}
