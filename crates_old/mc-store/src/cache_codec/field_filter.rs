//! Serialize only the selected fields of a derived record. Nested values use
//! the ordinary JSON serializer; omitted large fields are never traversed.
use serde::ser::{Error as _, Impossible, SerializeStruct, Serializer};
use serde::Serialize;

pub(super) struct RecordFields<'a, T> {
    pub value: &'a T,
    pub omit: &'static [&'static str],
    pub baseline_parts: Option<&'a [crate::TailHygienePartMeasurement]>,
}

impl<T: Serialize> Serialize for RecordFields<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(RecordSerializer {
            inner: serializer,
            omit: self.omit,
            baseline_parts: self.baseline_parts,
        })
    }
}

struct RecordSerializer<'a, S> {
    inner: S,
    omit: &'static [&'static str],
    baseline_parts: Option<&'a [crate::TailHygienePartMeasurement]>,
}

struct Fields<'a, S> {
    inner: S,
    omit: &'static [&'static str],
    baseline_parts: Option<&'a [crate::TailHygienePartMeasurement]>,
}

impl<S: SerializeStruct> SerializeStruct for Fields<'_, S> {
    type Ok = S::Ok;
    type Error = S::Error;
    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), S::Error> {
        if self.omit.contains(&key) {
            Ok(())
        } else if key == "baseline_parts" && self.baseline_parts.is_some() {
            self.inner
                .serialize_field(key, self.baseline_parts.unwrap())
        } else {
            self.inner.serialize_field(key, value)
        }
    }
    fn end(self) -> Result<S::Ok, S::Error> {
        self.inner.end()
    }
}

// These wrappers are used only for ModuleMeta and TailHygieneBaseline, whose
// derives emit a struct. A future change to either shape must fail explicitly.
macro_rules! reject_scalar {
    ($($name:ident($kind:ty);)*) => {$ (
        fn $name(self, _: $kind) -> Result<Self::Ok, Self::Error> {
            Err(Self::Error::custom("cache field filter expected a record"))
        }
    )*};
}

impl<'a, S: Serializer> Serializer for RecordSerializer<'a, S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = Impossible<S::Ok, S::Error>;
    type SerializeTuple = Impossible<S::Ok, S::Error>;
    type SerializeTupleStruct = Impossible<S::Ok, S::Error>;
    type SerializeTupleVariant = Impossible<S::Ok, S::Error>;
    type SerializeMap = Impossible<S::Ok, S::Error>;
    type SerializeStruct = Fields<'a, S::SerializeStruct>;
    type SerializeStructVariant = Impossible<S::Ok, S::Error>;

    reject_scalar! {
        serialize_bool(bool); serialize_i8(i8); serialize_i16(i16);
        serialize_i32(i32); serialize_i64(i64); serialize_u8(u8);
        serialize_u16(u16); serialize_u32(u32); serialize_u64(u64);
        serialize_f32(f32); serialize_f64(f64); serialize_char(char);
        serialize_str(&str); serialize_bytes(&[u8]);
    }
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn serialize_some<T: ?Sized + Serialize>(self, _: &T) -> Result<Self::Ok, Self::Error> {
        self.serialize_none()
    }
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
        self.serialize_none()
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<Self::Ok, Self::Error> {
        self.serialize_none()
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
    ) -> Result<Self::Ok, Self::Error> {
        self.serialize_none()
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        _: &T,
    ) -> Result<Self::Ok, Self::Error> {
        self.serialize_none()
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: &T,
    ) -> Result<Self::Ok, Self::Error> {
        self.serialize_none()
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn serialize_tuple_struct(
        self,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleStruct, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleVariant, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn serialize_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStruct, Self::Error> {
        Ok(Fields {
            inner: self.inner.serialize_struct(name, len)?,
            omit: self.omit,
            baseline_parts: self.baseline_parts,
        })
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStructVariant, Self::Error> {
        Err(Self::Error::custom("cache field filter expected a record"))
    }
    fn is_human_readable(&self) -> bool {
        self.inner.is_human_readable()
    }
}
