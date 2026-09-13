#!/usr/bin/env python3
"""Generate the sanitized, derived D5 uncovered-tail replay fixture."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import sqlite3
from pathlib import Path
from typing import Any

DB_SHA256 = "f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0"
CAPTURE_SHA256 = "766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b"

# The gateway owner (Thalamus) holds its own private view of the same defect:
# JSON snapshots of its store and the successor wire, not the VACUUM binary.
# Their hashes are recorded per artifact so both sides can tie this derived
# fixture to their sources without either publishing raw data.
GATEWAY_PRIVATE_EVIDENCE = {
    "root": "thalamus evidence reduction-descent-1789166531 (private, not in git or CI)",
    "note": "JSON snapshots of the gateway view at the defect; not the VACUUM binary.",
    "13610-req-body": {
        "bytes": 485039,
        "sha256": "766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b",
    },
    "mc_cache_state.json": {
        "bytes": 637068,
        "sha256": "e2efac16ec893d514c710cf59d797e5fa4c407e493108669e72f49c6d04f3b92",
    },
    "mc_compartments.json": {
        "bytes": 68983,
        "sha256": "bb2a96eb577c4993490c9b3cfb592d7e2e6f2cabbd62cb1620d21feb500d3912",
    },
    "mc_tags.json": {
        "bytes": 2075576,
        "sha256": "a157ee2ec343dbc6faa6e2464e9eaa42fd1b765eaf23318be186d00118515872",
    },
    "gateway_evidence_index_sha256": "825ccbee84a3d21886ace1097c22eb4f62b5b8afee5ae6e0115df4c8727abaae",
}
SOURCE_LABEL = f"VACUUM {DB_SHA256}"
GENERATOR_PATH = "packages/plugin/scripts/gen-d5-specimen-fixture.py"
CANONICAL_VECTORS_PATH = "crates/mc-module/tests/fixtures/d5-specimen/canonical-json-vectors-v1.json"
REDEEM_VECTORS_PATH = "crates/mc-module/tests/fixtures/d5-specimen/redeem-vectors-v1.json"
DIGEST_PLACEHOLDER = "<computed-by-slice-0>"
PREDECESSOR_KEY = "d5-fixture-predecessor"
ATTEMPT_ID = "d5-fixture-attempt-0001"
TAIL_START = 1799
TAIL_END = 1939
CAPTURE_START_POSITION = 64
PROBE_ORDINALS = (1824, 1864, 1927)


class JsonInteger(int):
    """A JSON integer together with the exact source token."""

    def __new__(cls, token: str) -> "JsonInteger":
        value = super().__new__(cls, token, 10)
        value.lexeme = token
        return value


class JsonFloat(float):
    """A JSON fraction or exponent together with the exact source token."""

    def __new__(cls, token: str) -> "JsonFloat":
        value = super().__new__(cls, token)
        value.lexeme = token
        return value


def reject_nonfinite(token: str) -> None:
    raise ValueError(f"non-finite JSON number {token}")


JSON_DECODER = json.JSONDecoder(
    parse_int=JsonInteger,
    parse_float=JsonFloat,
    parse_constant=reject_nonfinite,
)


def load_json(data: str | bytes) -> Any:
    text = data.decode() if isinstance(data, bytes) else data
    return JSON_DECODER.decode(text)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def compact_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def ecmascript_number_to_string(value: float) -> str:
    if not math.isfinite(value):
        raise SystemExit("canonical JSON forbids non-finite floats")
    if value == 0:
        return "0"

    sign = "-" if value < 0 else ""
    shortest = repr(abs(value)).lower()
    mantissa, separator, exponent_text = shortest.partition("e")
    exponent = int(exponent_text) if separator else 0
    integer, point, fraction = mantissa.partition(".")
    digits = integer + (fraction if point else "")
    decimal_position = len(integer) + exponent

    leading_zeroes = len(digits) - len(digits.lstrip("0"))
    digits = digits[leading_zeroes:].rstrip("0")
    decimal_position -= leading_zeroes
    digit_count = len(digits)

    if digit_count <= decimal_position <= 21:
        rendered = digits + "0" * (decimal_position - digit_count)
    elif 0 < decimal_position <= 21:
        rendered = digits[:decimal_position] + "." + digits[decimal_position:]
    elif -6 < decimal_position <= 0:
        rendered = "0." + "0" * (-decimal_position) + digits
    else:
        fraction = f".{digits[1:]}" if digit_count > 1 else ""
        scientific_exponent = decimal_position - 1
        exponent_sign = "+" if scientific_exponent >= 0 else "-"
        rendered = (
            f"{digits[0]}{fraction}e{exponent_sign}{abs(scientific_exponent)}"
        )
    return sign + rendered


def canonical_json_bytes(value: Any) -> bytes:
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False).encode()
    if isinstance(value, JsonInteger):
        return ("0" if value.lexeme == "-0" else value.lexeme).encode()
    if isinstance(value, int):
        return str(value).encode()
    if isinstance(value, float):
        return ecmascript_number_to_string(value).encode()
    if isinstance(value, list):
        return b"[" + b",".join(canonical_json_bytes(item) for item in value) + b"]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise SystemExit("canonical JSON object keys must be strings")
        fields = (
            canonical_json_bytes(key) + b":" + canonical_json_bytes(value[key])
            for key in sorted(value)
        )
        return b"{" + b",".join(fields) + b"}"
    raise SystemExit(f"unsupported canonical JSON value {type(value).__name__}")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def assert_digest(path: Path, expected: str, label: str) -> bytes:
    data = path.read_bytes()
    actual = sha256(data)
    if actual != expected:
        raise SystemExit(f"refusing {label}: expected sha256 {expected}, got {actual}")
    return data


def stand_in(ordinal: int, block_index: int, length: int, namespace: str = "block") -> bytes:
    marker = f"[sanitized:{namespace}:{ordinal}:{block_index}:{length}]".encode()
    return (marker * ((length + len(marker) - 1) // len(marker)))[:length]


def source_identity(ordinal: int, block_index: int) -> dict[str, Any]:
    return {"mid": f"ccm-{ordinal}", "index": block_index, "ordinal": ordinal}


class JsonNode:
    def __init__(
        self,
        value: Any,
        start: int,
        end: int,
        fields: dict[str, "JsonNode"] | None = None,
        items: list["JsonNode"] | None = None,
    ) -> None:
        self.value = value
        self.start = start
        self.end = end
        self.fields = fields
        self.items = items


class JsonSpanParser:
    def __init__(self, text: str) -> None:
        self.text = text

    def skip_whitespace(self, position: int) -> int:
        while position < len(self.text) and self.text[position] in " \t\r\n":
            position += 1
        return position

    def parse_string(self, position: int) -> JsonNode:
        start = position
        position += 1
        while position < len(self.text):
            character = self.text[position]
            if character == "\\":
                position += 2
            elif character == '"':
                position += 1
                token = self.text[start:position]
                return JsonNode(load_json(token), start, position)
            else:
                position += 1
        raise SystemExit("unterminated JSON string")

    def parse_value(self, position: int) -> JsonNode:
        position = self.skip_whitespace(position)
        start = position
        if self.text[position] == '"':
            return self.parse_string(position)
        if self.text[position] == "{":
            fields: dict[str, JsonNode] = {}
            position = self.skip_whitespace(position + 1)
            if self.text[position] == "}":
                return JsonNode({}, start, position + 1, fields=fields)
            while True:
                key = self.parse_string(position)
                position = self.skip_whitespace(key.end)
                if self.text[position] != ":":
                    raise SystemExit("expected colon in JSON object")
                child = self.parse_value(position + 1)
                fields[key.value] = child
                position = self.skip_whitespace(child.end)
                if self.text[position] == "}":
                    position += 1
                    return JsonNode(
                        {key: value.value for key, value in fields.items()},
                        start,
                        position,
                        fields=fields,
                    )
                if self.text[position] != ",":
                    raise SystemExit("expected comma in JSON object")
                position = self.skip_whitespace(position + 1)
        if self.text[position] == "[":
            items: list[JsonNode] = []
            position = self.skip_whitespace(position + 1)
            if self.text[position] == "]":
                return JsonNode([], start, position + 1, items=items)
            while True:
                child = self.parse_value(position)
                items.append(child)
                position = self.skip_whitespace(child.end)
                if self.text[position] == "]":
                    position += 1
                    return JsonNode(
                        [item.value for item in items], start, position, items=items
                    )
                if self.text[position] != ",":
                    raise SystemExit("expected comma in JSON array")
                position = self.skip_whitespace(position + 1)

        position += 1
        while position < len(self.text) and self.text[position] not in " \t\r\n,]}":
            position += 1
        token = self.text[start:position]
        return JsonNode(load_json(token), start, position)

    def parse(self) -> JsonNode:
        root = self.parse_value(0)
        if self.skip_whitespace(root.end) != len(self.text):
            raise SystemExit("trailing data in capture JSON")
        return root


def capture_provider_block_bytes(capture_bytes: bytes) -> list[list[bytes | None]]:
    text = capture_bytes.decode()
    root = JsonSpanParser(text).parse()
    if root.fields is None or root.fields.get("messages") is None:
        raise SystemExit("capture JSON has no messages array")
    messages = root.fields["messages"]
    if messages.items is None:
        raise SystemExit("capture messages is not an array")

    output: list[list[bytes | None]] = []
    for message in messages.items:
        if message.fields is None or message.fields.get("content") is None:
            raise SystemExit("capture message has no content")
        content = message.fields["content"]
        if content.items is None:
            output.append([None])
            continue
        output.append(
            [text[item.start : item.end].encode() for item in content.items]
        )
    return output


def provider_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = message["content"]
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list) or not all(isinstance(block, dict) for block in content):
        raise SystemExit("capture contains an unsupported message content shape")
    return content


def segment_blocks(ordinal: int, message: dict[str, Any]) -> list[dict[str, Any]]:
    blocks = provider_blocks(message)
    if ordinal == 1939:
        if len(blocks) != 2 or blocks[1].get("type") != "text":
            raise SystemExit("expected the recognized compaction addition at 1939#1")
        return blocks[:1]
    return blocks


TOP_LEVEL = "top_level"
TOOL_RESULT_CHILD = "tool_result_child"


def decoder_would_decode_known(context: str, role: str, block: Any) -> bool:
    """Match the pinned Claude Code decoder's typed boundary."""
    if not isinstance(block, dict):
        return False
    provider_kind = block.get("type")
    if context == TOOL_RESULT_CHILD:
        return provider_kind == "text" and isinstance(block.get("text"), str)
    if context != TOP_LEVEL:
        raise ValueError(f"unknown decoder context {context!r}")
    if provider_kind == "text":
        return isinstance(block.get("text"), str)
    if provider_kind == "thinking":
        return isinstance(block.get("thinking"), str) and isinstance(
            block.get("signature"), str
        )
    if provider_kind == "redacted_thinking":
        return isinstance(block.get("data"), str)
    if provider_kind == "tool_use":
        return (
            role == "assistant"
            and isinstance(block.get("id"), str)
            and isinstance(block.get("name"), str)
            and "input" in block
        )
    if provider_kind == "tool_result":
        return (
            role == "user"
            and isinstance(block.get("tool_use_id"), str)
            and "content" in block
        )
    return False


def contract_kind(context: str, role: str, block: Any) -> str:
    if not decoder_would_decode_known(context, role, block):
        return "opaque"
    provider_kind = block["type"]
    return {
        "thinking": "reasoning",
        "redacted_thinking": "redacted_reasoning",
    }.get(provider_kind, provider_kind)


def db_kind(contract_block_kind: str) -> str:
    return "tool_call" if contract_block_kind == "tool_use" else contract_block_kind


def opaque_string_nodes(node: JsonNode) -> list[JsonNode]:
    if node.fields is not None:
        return [
            child
            for value in node.fields.values()
            for child in opaque_string_nodes(value)
        ]
    if node.items is not None:
        return [child for value in node.items for child in opaque_string_nodes(value)]
    return [node] if isinstance(node.value, str) else []


def synthetic_ascii_character(
    character: str,
    ordinal: int,
    block_index: int,
    leaf_index: int,
    position: int,
) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz"
    seed = f"d5:{ordinal}:{block_index}:{leaf_index}:{position}".encode()
    selection = int.from_bytes(hashlib.sha256(seed).digest()[:4], "big") % 26
    replacement = alphabet[selection]
    return alphabet[(selection + 1) % 26] if replacement == character else replacement


def synthetic_character(
    character: str,
    ordinal: int,
    block_index: int,
    leaf_index: int,
    position: int,
) -> str:
    codepoint = ord(character)
    if character in {'"', "\\", "\n", "\r", "\t", "\b", "\f"}:
        return character
    if codepoint < 0x20:
        return "\0"
    if codepoint < 0x80:
        return synthetic_ascii_character(
            character, ordinal, block_index, leaf_index, position
        )
    width = len(character.encode())
    if width == 2:
        return "é"
    if width == 3:
        return "☃"
    if width == 4:
        return "😀"
    raise SystemExit(f"unsupported UTF-8 width at {ordinal}#{block_index}")


def sanitize_opaque_string_token(
    token: str, ordinal: int, block_index: int, leaf_index: int, probe: str | None
) -> str:
    decoded = load_json(token)
    if probe is not None and probe in decoded:
        raise SystemExit("approved probes in opaque blocks require a reviewed raw-token mapping")

    output = ['"']
    position = 0
    cursor = 1
    while cursor < len(token) - 1:
        if token[cursor] != "\\":
            character = token[cursor]
            output.append(
                synthetic_character(
                    character, ordinal, block_index, leaf_index, position
                )
            )
            cursor += 1
            position += 1
            continue

        escape = token[cursor : cursor + 2]
        if escape != "\\u":
            output.append(escape)
            cursor += 2
            position += 1
            continue

        escaped = token[cursor : cursor + 6]
        code_unit = int(escaped[2:], 16)
        if 0xD800 <= code_unit <= 0xDBFF and token[cursor + 6 : cursor + 8] == "\\u":
            escaped += token[cursor + 6 : cursor + 12]
            replacement = "\\ud83d\\ude00"
            cursor += 12
        else:
            character = load_json(f'"{escaped}"')
            replacement_character = synthetic_character(
                character, ordinal, block_index, leaf_index, position
            )
            replacement_codepoint = ord(replacement_character)
            replacement = f"\\u{replacement_codepoint:04x}"
            cursor += 6
        output.append(replacement)
        position += 1
    output.append('"')
    sanitized = "".join(output)
    if len(sanitized.encode()) != len(token.encode()):
        raise SystemExit(f"opaque string token length drift at {ordinal}#{block_index}")
    if len(load_json(sanitized).encode()) != len(decoded.encode()):
        raise SystemExit(f"opaque decoded string length drift at {ordinal}#{block_index}")
    return sanitized


def decoded_string_byte_lengths(value: Any) -> list[int]:
    if isinstance(value, dict):
        return [
            length
            for key in sorted(value)
            for length in decoded_string_byte_lengths(value[key])
        ]
    if isinstance(value, list):
        return [length for item in value for length in decoded_string_byte_lengths(item)]
    return [len(value.encode())] if isinstance(value, str) else []


def sanitize_opaque_block_bytes(
    raw: bytes,
    ordinal: int,
    block_index: int,
    probe: str | None,
    leaf_index_offset: int = 0,
) -> tuple[bytes, int, list[int]]:
    text = raw.decode()
    root = JsonSpanParser(text).parse()
    strings = opaque_string_nodes(root)
    output: list[str] = []
    cursor = 0
    for leaf_index, node in enumerate(strings, start=leaf_index_offset):
        output.append(text[cursor : node.start])
        token = text[node.start : node.end]
        output.append(
            sanitize_opaque_string_token(
                token, ordinal, block_index, leaf_index, probe
            )
        )
        cursor = node.end
    output.append(text[cursor:])
    sanitized_text = "".join(output)
    if len(sanitized_text.encode()) != len(raw):
        raise SystemExit(f"opaque block byte length drift at {ordinal}#{block_index}")
    cursor = 0
    for node in strings:
        if sanitized_text[cursor : node.start] != text[cursor : node.start]:
            raise SystemExit(f"opaque non-string bytes drift at {ordinal}#{block_index}")
        cursor = node.end
    if sanitized_text[cursor:] != text[cursor:]:
        raise SystemExit(f"opaque trailing bytes drift at {ordinal}#{block_index}")
    lengths = decoded_string_byte_lengths(load_json(sanitized_text))
    return sanitized_text.encode(), 0, lengths


def normalized_block_payload(
    context: str, role: str, block: dict[str, Any]
) -> dict[str, Any]:
    if not decoder_would_decode_known(context, role, block) or context == TOOL_RESULT_CHILD:
        return dict(block)
    return {
        key: value
        for key, value in block.items()
        if key not in {"type", "id", "tool_use_id"}
    }


def block_identity(block: Any) -> str:
    if not isinstance(block, dict):
        return "non-object block"
    provider_kind = block.get("type")
    provider_kind = provider_kind if isinstance(provider_kind, str) else "unknown"
    identity = block.get("id", block.get("tool_use_id"))
    return f"{provider_kind}[{identity}]" if isinstance(identity, str) else provider_kind


def first_opaque_descendant(role: str, block: dict[str, Any]) -> str | None:
    if block.get("type") != "tool_result" or not isinstance(block.get("content"), list):
        return None
    for index, child in enumerate(block["content"]):
        if not decoder_would_decode_known(TOOL_RESULT_CHILD, role, child):
            return f"content[{index}] {block_identity(child)}"
    return None


def normalized_raw_block_bytes(context: str, role: str, raw_provider_bytes: bytes) -> bytes:
    text = raw_provider_bytes.decode()
    root = JsonSpanParser(text).parse()
    if root.fields is None:
        raise SystemExit("provider block must be a JSON object")
    if not decoder_would_decode_known(context, role, root.value):
        return raw_provider_bytes
    if context == TOOL_RESULT_CHILD:
        return canonical_json_bytes(root.value)

    provider_kind = root.value.get("type", "")
    fields: list[bytes] = []
    for key in sorted(root.fields):
        if key in {"type", "id", "tool_use_id"}:
            continue
        child = root.fields[key]
        if provider_kind == "tool_result" and key == "content" and child.items is not None:
            items = [
                normalized_raw_block_bytes(
                    TOOL_RESULT_CHILD,
                    role,
                    text[item.start : item.end].encode(),
                )
                for item in child.items
            ]
            value_bytes = b"[" + b",".join(items) + b"]"
        else:
            value_bytes = canonical_json_bytes(child.value)
        fields.append(canonical_json_bytes(key) + b":" + value_bytes)
    return b"{" + b",".join(fields) + b"}"


def normalized_block_bytes(
    context: str,
    role: str,
    block: dict[str, Any],
    raw_provider_bytes: bytes | None = None,
) -> bytes:
    if raw_provider_bytes is not None:
        return normalized_raw_block_bytes(context, role, raw_provider_bytes)
    if not decoder_would_decode_known(context, role, block):
        raise SystemExit(
            f"opaque {block_identity(block)} is missing its raw JSON bytes"
        )
    opaque_descendant = first_opaque_descendant(role, block)
    if context == TOP_LEVEL and opaque_descendant is not None:
        raise SystemExit(
            f"{block_identity(block)} has opaque descendant {opaque_descendant} "
            "but raw JSON bytes are unavailable"
        )
    return canonical_json_bytes(normalized_block_payload(context, role, block))


def synthetic_string_segment(
    value: str,
    ordinal: int,
    block_index: int,
    leaf_index: int,
    character_offset: int,
) -> str:
    sanitized: list[str] = []
    for relative_index, character in enumerate(value):
        position = character_offset + relative_index
        sanitized.append(
            synthetic_character(
                character, ordinal, block_index, leaf_index, position
            )
        )
    result = "".join(sanitized)
    if len(result.encode()) != len(value.encode()):
        raise SystemExit(f"string byte length drift at {ordinal}#{block_index}")
    if len(json.dumps(result, ensure_ascii=False).encode()) != len(
        json.dumps(value, ensure_ascii=False).encode()
    ):
        raise SystemExit(f"string JSON length drift at {ordinal}#{block_index}")
    return result


def sanitized_block_bytes(
    role: str,
    block: dict[str, Any],
    raw_provider_bytes: bytes | None,
    ordinal: int,
    block_index: int,
    probe: str | None,
) -> tuple[bytes, int, list[int]]:
    if not decoder_would_decode_known(TOP_LEVEL, role, block):
        if raw_provider_bytes is None:
            raise SystemExit("opaque provider block is missing its raw JSON bytes")
        return sanitize_opaque_block_bytes(
            raw_provider_bytes, ordinal, block_index, probe
        )

    leaf_index = 0
    probe_hits = 0
    string_byte_lengths: list[int] = []

    def sanitize(value: Any) -> Any:
        nonlocal leaf_index, probe_hits
        if isinstance(value, dict):
            return {key: sanitize(value[key]) for key in sorted(value)}
        if isinstance(value, list):
            return [sanitize(item) for item in value]
        if not isinstance(value, str):
            return value

        current_leaf = leaf_index
        leaf_index += 1
        string_byte_lengths.append(len(value.encode()))
        if probe is not None:
            occurrences = value.count(probe)
            if occurrences > 1:
                raise SystemExit(
                    f"probe appears more than once at {ordinal}#{block_index} string {current_leaf}"
                )
            if occurrences == 1:
                prefix, suffix = value.split(probe)
                probe_hits += 1
                return (
                    synthetic_string_segment(
                        prefix, ordinal, block_index, current_leaf, 0
                    )
                    + probe
                    + synthetic_string_segment(
                        suffix,
                        ordinal,
                        block_index,
                        current_leaf,
                        len(prefix) + len(probe),
                    )
                )
        return synthetic_string_segment(
            value, ordinal, block_index, current_leaf, 0
        )

    raw = normalized_block_bytes(TOP_LEVEL, role, block, raw_provider_bytes)
    if raw_provider_bytes is None:
        sanitized = canonical_json_bytes(
            sanitize(normalized_block_payload(TOP_LEVEL, role, block))
        )
    else:
        text = raw_provider_bytes.decode()
        root = JsonSpanParser(text).parse()
        if root.fields is None:
            raise SystemExit("provider block must be a JSON object")
        provider_kind = root.value.get("type", "")
        fields: list[bytes] = []
        for key in sorted(root.fields):
            if key in {"type", "id", "tool_use_id"}:
                continue
            child = root.fields[key]
            if (
                provider_kind == "tool_result"
                and key == "content"
                and child.items is not None
            ):
                items = []
                for item in child.items:
                    if not decoder_would_decode_known(
                        TOOL_RESULT_CHILD, role, item.value
                    ):
                        item_raw = text[item.start : item.end].encode()
                        item_bytes, item_probe_hits, item_lengths = (
                            sanitize_opaque_block_bytes(
                                item_raw,
                                ordinal,
                                block_index,
                                probe,
                                leaf_index,
                            )
                        )
                        leaf_index += len(item_lengths)
                        probe_hits += item_probe_hits
                        string_byte_lengths.extend(item_lengths)
                        items.append(item_bytes)
                    else:
                        items.append(canonical_json_bytes(sanitize(item.value)))
                value_bytes = b"[" + b",".join(items) + b"]"
            else:
                value_bytes = canonical_json_bytes(sanitize(child.value))
            fields.append(canonical_json_bytes(key) + b":" + value_bytes)
        sanitized = b"{" + b",".join(fields) + b"}"
    if len(sanitized) != len(raw):
        raise SystemExit(
            f"provider block byte length drift at {ordinal}#{block_index}: "
            f"expected {len(raw)}, got {len(sanitized)}"
        )
    return sanitized, probe_hits, string_byte_lengths


def parse_block_id(block_id: str) -> tuple[int, int]:
    mid, raw_index = block_id.split("#", 1)
    if not mid.startswith("ccm-"):
        raise SystemExit(f"unexpected block identity {block_id}")
    return int(mid.removeprefix("ccm-")), int(raw_index)


def rewrite_tool_ids(tail: list[dict[str, Any]]) -> tuple[dict[str, str], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    rewritten: dict[str, str] = {}
    uses: dict[str, dict[str, Any]] = {}
    results: dict[str, dict[str, Any]] = {}
    sequence = 0
    for ordinal, message in zip(range(TAIL_START, TAIL_END + 1), tail):
        for index, block in enumerate(segment_blocks(ordinal, message)):
            kind = block.get("type")
            if kind == "tool_use":
                original = block.get("id")
                if not isinstance(original, str) or original in uses:
                    raise SystemExit(f"invalid or duplicate tool use at {ordinal}#{index}")
                sequence += 1
                rewritten[original] = f"toolu_d5_{sequence:04d}"
                uses[original] = source_identity(ordinal, index)
            elif kind == "tool_result":
                original = block.get("tool_use_id")
                if not isinstance(original, str) or original in results:
                    raise SystemExit(f"invalid or duplicate tool result at {ordinal}#{index}")
                results[original] = source_identity(ordinal, index)
    if uses.keys() != results.keys():
        missing_results = sorted(uses.keys() - results.keys())
        missing_uses = sorted(results.keys() - uses.keys())
        raise SystemExit(
            f"tool arcs are not closed: missing results={len(missing_results)}, missing uses={len(missing_uses)}"
        )
    return rewritten, uses, results


def tool_links(
    block: dict[str, Any],
    rewritten: dict[str, str],
    uses: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    if block.get("type") == "tool_use":
        original = block.get("id")
    elif block.get("type") == "tool_result":
        original = block.get("tool_use_id")
    else:
        return []
    if not isinstance(original, str):
        return []
    return [
        {
            "tool_use_id": rewritten[original],
            "use_identity": uses[original],
            "result_identity": results[original],
        }
    ]


def load_source_state(db_path: Path, probes: list[dict[str, Any]]) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    candidates: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for row in connection.execute("SELECT session_id, core_state, meta FROM mc_cache_state"):
        meta = load_json(row["meta"])
        if meta.get("coverage_ordinal") == 1798 and meta.get("newest_live_ordinal") == 1939:
            candidates.append((row["session_id"], load_json(row["core_state"]), meta))
    if len(candidates) != 1:
        raise SystemExit(f"expected one D5 predecessor state, found {len(candidates)}")
    session_id, core, meta = candidates[0]

    tags = [
        dict(row)
        for row in connection.execute(
            "SELECT tag_number, block_id, kind, token_count, source_bytes "
            "FROM mc_tags WHERE session_id=? ORDER BY tag_number",
            (session_id,),
        )
        if TAIL_START <= parse_block_id(row["block_id"])[0] <= TAIL_END
    ]
    by_number = {row["tag_number"]: row for row in tags}
    for probe in probes:
        tag = by_number.get(probe["tag"])
        if tag is None or tag["block_id"] != probe["block_id"]:
            raise SystemExit(f"probe tag {probe['tag']} is absent or has the wrong identity")
        if probe["string"].encode() not in tag["source_bytes"]:
            raise SystemExit(f"probe tag {probe['tag']} does not contain its approved string")

    red_units = {
        unit["key"].removeprefix("red:"): unit
        for unit in core.get("frozen_units", [])
        if unit.get("key", "").startswith("red:")
        and TAIL_START <= parse_block_id(unit["key"].removeprefix("red:"))[0] <= TAIL_END
    }
    drops = [
        dict(row)
        for row in connection.execute(
            "SELECT target_id, command_id FROM pending_agent_drops "
            "WHERE session_id=? ORDER BY id",
            (session_id,),
        )
    ]
    ledgers = [
        dict(row)
        for row in connection.execute(
            "SELECT command_id, first_applied_at_ms, disposition "
            "FROM mc_reduce_command_ledger WHERE session_id=? ORDER BY command_id",
            (session_id,),
        )
    ]
    connection.close()
    return {
        "meta": meta,
        "tags": tags,
        "tagged_ordinals": {parse_block_id(row["block_id"])[0] for row in tags},
        "red_units": red_units,
        "drops": drops,
        "ledgers": ledgers,
    }


def validate_db_kinds(state: dict[str, Any], tail: list[dict[str, Any]]) -> None:
    identities = state["meta"].get("block_identity_by_mid", {})
    tagged_ordinals = state["tagged_ordinals"]
    for ordinal, message in zip(range(TAIL_START, TAIL_END + 1), tail):
        if ordinal not in tagged_ordinals:
            continue
        expected = identities.get(f"ccm-{ordinal}")
        if not isinstance(expected, list):
            raise SystemExit(f"tagged member {ordinal} has no DB block-kind fingerprints")
        actual = [
            db_kind(contract_kind(TOP_LEVEL, message["role"], block))
            for block in segment_blocks(ordinal, message)
        ]
        persisted = [block.get("kind_tag") for block in expected]
        if actual != persisted:
            raise SystemExit(f"capture/DB block-kind mismatch at ordinal {ordinal}")


def build_fixture(
    state: dict[str, Any],
    capture: dict[str, Any],
    raw_provider_blocks: list[list[bytes | None]],
    probes: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    messages = capture.get("messages")
    if not isinstance(messages, list) or len(messages) != 205:
        raise SystemExit("capture must contain exactly 205 messages")
    tail = messages[CAPTURE_START_POSITION:]
    raw_tail = raw_provider_blocks[CAPTURE_START_POSITION:]
    if len(tail) != 141 or len(raw_tail) != 141:
        raise SystemExit("capture tail must contain exactly 141 messages")
    roles = {role: sum(message.get("role") == role for message in tail) for role in ("assistant", "user", "system")}
    if roles != {"assistant": 70, "user": 70, "system": 1}:
        raise SystemExit(f"unexpected tail roles: {roles}")

    validate_db_kinds(state, tail)
    rewritten, uses, results = rewrite_tool_ids(tail)
    probe_by_ordinal = {
        parse_block_id(probe["block_id"])[0]: probe["string"].encode() for probe in probes
    }
    if tuple(sorted(probe_by_ordinal)) != PROBE_ORDINALS:
        raise SystemExit("probe ordinals do not match the D5 contract")

    source_messages: list[dict[str, Any]] = []
    manifest_messages: list[dict[str, Any]] = []
    projected_messages: list[str] = []
    member_sources: list[dict[str, Any]] = []
    for position, ordinal, message, message_raw_blocks in zip(
        range(CAPTURE_START_POSITION, CAPTURE_START_POSITION + len(tail)),
        range(TAIL_START, TAIL_END + 1),
        tail,
        raw_tail,
    ):
        native_blocks: list[dict[str, Any]] = []
        manifest_blocks: list[dict[str, Any]] = []
        normalized_blocks: list[dict[str, Any]] = []
        probe_bytes = probe_by_ordinal.get(ordinal)
        probe = probe_bytes.decode() if probe_bytes is not None else None
        probe_hits = 0
        source_length = 0
        block_byte_lengths: list[int] = []
        block_string_byte_lengths: list[list[int]] = []
        block_kinds: list[str] = []
        blocks = segment_blocks(ordinal, message)
        raw_blocks = message_raw_blocks[: len(blocks)]
        if len(raw_blocks) != len(blocks):
            raise SystemExit(f"raw provider block count mismatch at {ordinal}")
        for index, (block, raw_provider_bytes) in enumerate(zip(blocks, raw_blocks)):
            raw = normalized_block_bytes(
                TOP_LEVEL, message["role"], block, raw_provider_bytes
            )
            source_length += len(raw)
            block_byte_lengths.append(len(raw))
            sanitized, block_probe_hits, string_byte_lengths = sanitized_block_bytes(
                message["role"], block, raw_provider_bytes, ordinal, index, probe
            )
            block_string_byte_lengths.append(string_byte_lengths)
            probe_hits += block_probe_hits
            if probe_hits > 1:
                raise SystemExit(f"probe appears in multiple blocks at ordinal {ordinal}")
            links = tool_links(block, rewritten, uses, results)
            kind = contract_kind(TOP_LEVEL, message["role"], block)
            block_kinds.append(kind)
            native_block = {
                "index": index,
                "kind": kind,
                "bytes": b64(sanitized),
                "provenance": {"kind": "native"},
                "tool_links": links,
            }
            native_blocks.append(native_block)

            block_id = f"ccm-{ordinal}#{index}"
            applied = state["red_units"].get(block_id)
            if applied is None:
                served = sanitized
                unit_key = None
            else:
                payload = applied["frozen_payload"].encode()
                served = stand_in(ordinal, index, len(payload), "unit")
                unit_key = applied["key"]
            manifest_blocks.append(
                {
                    "index": index,
                    "kind": kind,
                    "predecessor_identity": source_identity(ordinal, index),
                    "provenance": {
                        "kind": "native",
                        "attempt_id": ATTEMPT_ID,
                        "predecessor_key": PREDECESSOR_KEY,
                        "message_position": position,
                    },
                    "source": {"len": len(sanitized), "sha256": DIGEST_PLACEHOLDER},
                    "served": {"len": len(served), "sha256": DIGEST_PLACEHOLDER},
                    "applied_unit": unit_key,
                    "tool_links": links,
                }
            )
            normalized_blocks.append(
                {
                    "index": index,
                    "kind": kind,
                    "bytes": b64(served),
                    "provenance": {"kind": "native"},
                    "tool_links": links,
                }
            )
        if probe is not None and probe_hits != 1:
            raise SystemExit(f"capture member {ordinal} does not contain its approved probe")

        source_messages.append(
            {
                "position": position,
                "ordinal": ordinal,
                "mid": f"ccm-{ordinal}",
                "role": message["role"],
                "blocks": native_blocks,
            }
        )
        manifest_messages.append(
            {
                "ordinal": ordinal,
                "native_mid": f"ccm-{ordinal}",
                "native_position": position,
                "role": message["role"],
                "blocks": manifest_blocks,
            }
        )
        projected_messages.append(
            b64(
                compact_json_bytes(
                    {
                        "position": position,
                        "ordinal": ordinal,
                        "role": message["role"],
                        "blocks": normalized_blocks,
                    }
                )
            )
        )
        member_sources.append(
            {
                "ordinal": ordinal,
                "block_count": len(native_blocks),
                "block_kinds": block_kinds,
                "block_byte_lengths": block_byte_lengths,
                "block_string_byte_lengths": block_string_byte_lengths,
                "block_length_preservation": ["both"] * len(native_blocks),
                "source_byte_length": source_length,
                "length_source": "capture_13610",
                "kinds_source": "db" if ordinal in state["tagged_ordinals"] else "capture_13610",
                "tool_links_source": "capture_13610",
                "geometry": "measured",
            }
        )

    source_segment = {
        "normalization_version": 1,
        "messages": source_messages,
        "excluded_additions": [
            {"kind": "recognized_compaction", "addition_kind": "claude_code_compaction_instruction"}
        ],
    }
    manifest = {
        "schema_version": 1,
        "normalization_version": 1,
        "encoding_version": 1,
        "messages": manifest_messages,
    }
    expected_manifest = {**manifest, "digests_pending": True}
    applied_state = build_applied_state(state, probe_by_ordinal)
    expected_archive = {
        "schema_version": 1,
        "archive_id": DIGEST_PLACEHOLDER,
        "encoding_version": 1,
        "manifest": manifest,
        "V": projected_messages,
        "A": {"schema_version": 1, "canonical_payload": b64(compact_json_bytes(applied_state))},
        "digests_pending": True,
    }
    return source_segment, expected_manifest, expected_archive, member_sources


def build_applied_state(state: dict[str, Any], probes: dict[int, bytes]) -> dict[str, Any]:
    command_ids = sorted(
        {row["command_id"] for row in state["drops"]}
        | {row["command_id"] for row in state["ledgers"]}
    )
    rewritten_commands = {command_id: f"cmd-d5-{index + 1:04d}" for index, command_id in enumerate(command_ids)}
    units = []
    for block_id, unit in sorted(state["red_units"].items(), key=lambda item: parse_block_id(item[0])):
        ordinal, index = parse_block_id(block_id)
        payload = unit["frozen_payload"].encode()
        units.append(
            {
                "unit": unit["key"],
                "kind": unit["kind"],
                "durability_class": unit["durability_class"],
                "reset_rule": unit["reset_rule"],
                "bytes": b64(stand_in(ordinal, index, len(payload), "unit")),
            }
        )
    tags = []
    for row in state["tags"]:
        ordinal, index = parse_block_id(row["block_id"])
        source = stand_in(ordinal, index, len(row["source_bytes"]), "tag")
        probe = probes.get(ordinal)
        if probe is not None:
            source = probe + stand_in(ordinal, index, len(source) - len(probe), "tag-tail")
        tags.append(
            {
                "tag_number": row["tag_number"],
                "target": source_identity(ordinal, index),
                "kind": row["kind"],
                "source_len": len(source),
                "source_bytes": b64(source),
            }
        )
    drops = [
        {
            "command_id": rewritten_commands[row["command_id"]],
            "target": source_identity(*parse_block_id(row["target_id"])),
            "state": "pending",
        }
        for row in state["drops"]
    ]
    ledger = [
        {
            "command_id": rewritten_commands[row["command_id"]],
            "first_applied": row["first_applied_at_ms"] is not None,
            "disposition": row["disposition"],
        }
        for row in state["ledgers"]
    ]
    return {"units": units, "tags": tags, "drops": drops, "ledger": ledger}


def validate_representation_contract(canonical_vectors: bytes) -> None:
    document = load_json(canonical_vectors)
    rules = document.get("normative_algorithm", [])
    if [rule.get("rule") for rule in rules] != list(range(1, 10)):
        raise SystemExit("canonical JSON normative rules are incomplete")
    if document.get("number_reference", {}).get("engine") != "Node.js v22.23.1":
        raise SystemExit("canonical JSON number reference engine drift")
    vectors = document.get("vectors", [])
    if len(vectors) != 31:
        raise SystemExit("canonical JSON vector count drift")
    for vector in vectors:
        expected = vector["expected_utf8"].encode()
        actual = canonical_json_bytes(vector["input"])
        if actual != expected or sha256(expected) != vector["sha256"]:
            raise SystemExit(f"canonical JSON vector failed: {vector['name']}")

    extension_block = {
        "type": "text",
        "id": "provider-id",
        "text": "visible",
        "vendor_extension": {"array": [True, 7, None]},
    }
    expected_extension = {
        "text": "visible",
        "vendor_extension": {"array": [True, 7, None]},
    }
    if (
        normalized_block_payload(TOP_LEVEL, "assistant", extension_block)
        != expected_extension
    ):
        raise SystemExit("known provider extension was not preserved")

    block_reference = document.get("block_aware_reference", {})
    if "(context, role, block)" not in block_reference.get("note", ""):
        raise SystemExit("N4 decoded-boundary reference is missing")
    boundary_table = block_reference.get("decoder_boundary_table", [])
    if len(boundary_table) != 12 or any(
        "anthropic_decode.rs:" not in row.get("decoder_cite", "")
        for row in boundary_table
    ):
        raise SystemExit("N4 decoded-boundary table drift")
    block_vectors = document.get("block_aware_vectors", [])
    if len(block_vectors) != 18:
        raise SystemExit("N4 block-aware vector count drift")
    for vector in block_vectors:
        input_raw = vector["input_json"].encode()
        input_block = load_json(input_raw)
        expected = vector["expected_utf8"].encode()
        context = vector["context"]
        role = vector["role"]
        if contract_kind(context, role, input_block) != vector["expected_kind"]:
            raise SystemExit(f"N4 decoded kind failed: {vector['name']}")
        if (
            normalized_raw_block_bytes(context, role, input_raw) != expected
            or sha256(expected) != vector["sha256"]
        ):
            raise SystemExit(f"N4 block-aware vector failed: {vector['name']}")
        raw_withheld = vector.get("raw_withheld")
        if raw_withheld is not None:
            if raw_withheld.get("expected") != "refusal":
                raise SystemExit(f"N4 refusal outcome drift: {vector['name']}")
            if raw_withheld.get("expected_utf8", "not-null") is not None:
                raise SystemExit(f"N4 refusal unexpectedly specifies bytes: {vector['name']}")
            try:
                normalized_block_bytes(context, role, input_block)
            except SystemExit as error:
                if raw_withheld["error_contains"] not in str(error):
                    raise SystemExit(
                        f"N4 refusal identity failed: {vector['name']}: {error}"
                    ) from error
            else:
                raise SystemExit(f"N4 raw-withheld refusal failed: {vector['name']}")

    opaque_control = document["opaque_control"]
    opaque_raw = opaque_control["input_json"].encode()
    opaque = load_json(opaque_raw)
    if contract_kind(TOP_LEVEL, "assistant", opaque) != "opaque":
        raise SystemExit("unknown provider block did not map to opaque")
    expected = opaque_control["expected_utf8"].encode()
    if opaque_raw != expected or sha256(expected) != opaque_control["sha256"]:
        raise SystemExit("opaque raw-byte identity control failed")
    sanitized, probe_hits, string_lengths = sanitize_opaque_block_bytes(
        opaque_raw, 1, 0, None
    )
    if len(sanitized) != len(opaque_raw) or probe_hits != 0 or not string_lengths:
        raise SystemExit("opaque in-place sanitization control failed")


def readme_text() -> str:
    return f"""# D5 specimen fixture

This is the MC-owned, **DERIVED** and sanitized specimen for the D5 uncovered predecessor tail. It carries 141 ordered members (1799–1939) for joint Magic Context/Thalamus replay without committing the private source capture or store.

Provenance:

- store membership and tagged-member kinds: `{SOURCE_LABEL}`
- byte lengths, untagged-member kinds, roles, block geometry, and tool links: capture `13610-req-body`, SHA-256 `{CAPTURE_SHA256}`
- attribute counts: lengths: 141 from capture; kinds: 83 from db, 58 from capture; tool links: 141 from capture

Sanitization preserves message order, ordinals, roles, normalized source block counts and kinds, each provider block's JSON structure, per-block encoded byte lengths, every string leaf's decoded UTF-8 byte length, reduction lengths, and closed tool-use/result arcs. All 188 blocks preserve both length measures; zero are encoded-only or decoded-only, and this capture contains zero opaque blocks. Object keys, nesting, arrays, numbers, booleans, and nulls are real; string leaf values are synthetic equal-length fillers chosen from the source character's JSON escape and UTF-8 width class. The recognized compaction instruction at 1939#1 is excluded as a contract provenance addition rather than treated as predecessor source. Only the approved probe string in each of ordinals 1824, 1864, and 1927 remains verbatim at its original position inside its synthetic string value. It does **not** preserve token counts, historian quality, semantic content outside those probes, or provider-valid reasoning signatures. Reasoning signatures are synthetic.

Contract clause 2 (types) pins `NativeBlock.bytes` to this normative canonical JSON algorithm:

1. Parse valid JSON while retaining whether every number used integer syntax or fraction/exponent syntax, and emit UTF-8.
2. Sort object keys lexicographically by Unicode code point, never by key length or source order.
3. Use `,` and `:` separators with no surrounding whitespace.
4. Do not ASCII-escape non-ASCII characters. Escape only quote, backslash, and U+0000–U+001F: use `\\n`, `\\r`, `\\t`, `\\b`, and `\\f` short forms, and lowercase `\\uXXXX` for the remaining controls.
5. N1 — Preserve an integer-syntax number as canonical decimal text: no leading `+` or zeroes, map `-0` to `0`, and never route arbitrary-magnitude integers through binary64.
6. N2 — Parse a fraction- or exponent-syntax number as finite IEEE-754 binary64 and serialize it with ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20 / `JSON.stringify`): shortest round-trip digits; plain decimal when 1e-6 ≤ |x| < 1e21, otherwise lowercase exponent notation with `+` retained for positive exponents; omit an integral fraction and map negative zero to `0`.
7. N3 — Apply N1/N2 independently of language-default number formatters; Python re-lays out `repr`'s shortest digits instead of emitting `repr` directly, and Rust uses an exact ECMAScript formatter rather than `serde_json` Display.
8. N4 — At every block boundary, classify by decoded context, wire role, and payload validity, never by a raw `type` allowlist. `TopLevel` follows Broca `decode_content_block` (`79b1272e` `anthropic_decode.rs:560-607`); `ToolResultChild` follows `decode_result_block` (`79b1272e` `anthropic_decode.rs:648-661`). Canonicalize only blocks those functions decode to typed `ContentKind` or `ResultBlockKind`; preserve every other block's exact raw bytes. Descend only from a known user-role `tool_result` container into its content array. `tool_use` input is ordinary JSON data and is never block-scanned. If any opaque descendant lacks its raw bytes, refuse canonicalization rather than reconstructing it.
9. Emit no trailing newline.

Decoded-boundary table:

| Context | Role | Block/payload | Boundary result | Pinned decoder |
|---|---|---|---|---|
| `TopLevel` | any | `text` with string `text` | known `text` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `thinking` with string `thinking` and `signature` | known `reasoning`; both fields retained | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `thinking` without a valid string signature | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `redacted_thinking` with string `data` | known `redacted_reasoning` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | assistant | `tool_use` with string `id`/`name` and present `input` | known `tool_use` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | user | `tool_use` | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | user | `tool_result` with string `tool_use_id` and present `content` | known container; children use `ToolResultChild` | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | `image` or `document` | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | malformed payload of a recognized type | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `TopLevel` | any | unknown type | opaque, exact raw bytes | `79b1272e anthropic_decode.rs:560-607` |
| `ToolResultChild` | user | `text` with string `text` | known `ResultBlockKind::Text` | `79b1272e anthropic_decode.rs:648-661` |
| `ToolResultChild` | user | anything else, including signed `thinking` or nested `tool_result` | opaque child, exact raw bytes, no recursion | `79b1272e anthropic_decode.rs:648-661` |

These rules are the definition; `canonical-json-vectors-v1.json` contains independent hand-written conformance checks designed to distinguish wrong ordering, escaping, and number algorithms. Decoder-known top-level blocks lift `type`, `id`, and `tool_use_id` into contract kind/tool-link fields while retaining every other provider field. Scalar text is normalized as `{{"text": ...}}`. Archive `V` entries are base64 compact JSON renderings of `NormalizedMessage` in contract field order; the applied-state payload is a stable JSON scaffold for units, tags, drops, and ledger without token counts or clocks.

## Opaque blocks

A decoder-opaque provider block lifts nothing, receives kind `opaque`, and preserves its exact raw provider bytes, including key order, whitespace, and escape and number spelling. This includes top-level image/document blocks, malformed recognized types, role-invalid typed blocks, unknown types, and every non-text `ToolResultChild`. Raw preservation keeps content and identity digests over opaque blocks equal across adapters; in this derived fixture only string values are sanitized in place, without re-serializing or changing any non-string byte.

N4's decoded-context boundary is the pinned Claude Code D5 rule, not a fixture convenience. The parent `tool_result` object and known text children remain canonical around each raw opaque child. A nested `tool_result` is itself opaque and is not recursively treated as a container. Canonicalization refuses when an opaque descendant's raw bytes are unavailable. Widening requires a contract and vector revision.

OpenCode and Pi consume different API structures and are not inputs to the Claude Code D5 rule. OpenCode emits decoded `Text` from `output_text` at `opencode.rs:703-707` and separately classifies attachments at `opencode.rs:719-738`; Pi parses its separate harness surface at `pi.rs:845-892`. Their current classification differences belong to a parity follow-up, not this fixture's identity rule.

`expected-manifest-v1.json` and `expected-archive-v1.json` remain scaffolds, not oracles, despite the real structure and lengths. Readiness stays `scaffold` until slice 0 fills every pending digest from **independent** reference-implementation preimage vectors and hand-checked CE1 preimage vectors—not from the codec under test—and freezes the results.

## Redeem vector encoding

No D5 lineage serializer exists at this baseline. The closest tagged module fixture union is internally tagged (`crates/mc-module/src/tail_hygiene.rs:1212-1238`), while the current facade state-sync request is a struct rather than an operation union (`crates/mc-module/src/lib.rs:793-863`). Clause 2 therefore controls deliberately: `LineageRequest` is one internally tagged object whose `op` discriminator and redeem fields are siblings with no `args` wrapper; `LineageResponse` uses the externally keyed clause spelling `{{"redeem":{{"result":...}}}}`; and nested payload unions are internally tagged by `kind`. This is the pinned wire rule slice 2 must implement. The owner-authored expectations in `redeem-vectors-v1.json` are independent fixture data, never generated from the precedence evaluator.

Regenerate from the two private inputs:

```sh
python3 {GENERATOR_PATH} \\
  /path/to/d5-specimen.db \\
  /path/to/13610-req-body
```

The generator refuses either input unless its SHA-256 matches the values above. `fixture-index-v1.json` catalogs every sibling fixture file; it cannot hash itself without a recursive self-reference.
"""


def write_fixture(
    output: Path,
    source_segment: dict[str, Any],
    manifest: dict[str, Any],
    archive: dict[str, Any],
    member_sources: list[dict[str, Any]],
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    repository_root = Path(__file__).resolve().parents[3]
    canonical_vectors = (repository_root / CANONICAL_VECTORS_PATH).read_bytes()
    redeem_vectors = (repository_root / REDEEM_VECTORS_PATH).read_bytes()
    validate_representation_contract(canonical_vectors)
    payloads = {
        "source-segment-v1.json": json_bytes(source_segment),
        "expected-manifest-v1.json": json_bytes(manifest),
        "expected-archive-v1.json": json_bytes(archive),
        "canonical-json-vectors-v1.json": canonical_vectors,
        "redeem-vectors-v1.json": redeem_vectors,
        "README.md": readme_text().encode(),
    }
    for name, data in payloads.items():
        (output / name).write_bytes(data)

    entries = []
    redaction = (
        "all string leaf values replaced with deterministic equal-length synthetic fillers; "
        "138 members retain no source text and three probe members retain only their approved probe string"
    )
    for name, data in payloads.items():
        if name in {"canonical-json-vectors-v1.json", "redeem-vectors-v1.json"}:
            source = (
                "hand-written independent canonical-form vectors"
                if name == "canonical-json-vectors-v1.json"
                else "owner-authored D5 redeem contract vectors"
            )
            entries.append(
                {
                    "path": name,
                    "byte_size": len(data),
                    "sha256": sha256(data),
                    "derived": False,
                    "source": source,
                    "generation_script": GENERATOR_PATH,
                }
            )
            continue
        entries.append(
            {
                "path": name,
                "byte_size": len(data),
                "sha256": sha256(data),
                "derived": True,
                "source": SOURCE_LABEL,
                "length_geometry_source": f"capture_13610 {CAPTURE_SHA256}",
                "sanitized_members": 138,
                "verbatim_members": list(PROBE_ORDINALS),
                "redaction_method": redaction,
                "generation_script": GENERATOR_PATH,
            }
        )
    index = {
        "schema_version": 1,
        "fixture_shape_version": 5,
        "readiness": "scaffold",
        "opaque_blocks": sum(
            block_kind == "opaque"
            for item in member_sources
            for block_kind in item["block_kinds"]
        ),
        "length_preservation": {
            "both": sum(item["block_count"] for item in member_sources),
            "encoded_only": 0,
            "decoded_only": 0,
        },
        "source_db_sha256": DB_SHA256,
        "capture_13610_sha256": CAPTURE_SHA256,
        "gateway_private_evidence": GATEWAY_PRIVATE_EVIDENCE,
        "members": member_sources,
        "files": entries,
    }
    (output / "fixture-index-v1.json").write_bytes(json_bytes(index))


def refresh_fixture_index(output: Path) -> None:
    """Refresh hashes without requiring the private source inputs."""
    index_path = output / "fixture-index-v1.json"
    index = load_json(index_path.read_bytes())
    entries = {entry["path"]: entry for entry in index["files"]}
    redeem_path = output / "redeem-vectors-v1.json"
    redeem_bytes = redeem_path.read_bytes()
    entries[redeem_path.name] = {
        "path": redeem_path.name,
        "byte_size": len(redeem_bytes),
        "sha256": sha256(redeem_bytes),
        "derived": False,
        "source": "owner-authored D5 redeem contract vectors",
        "generation_script": GENERATOR_PATH,
    }
    ordered_names = [
        "source-segment-v1.json",
        "expected-manifest-v1.json",
        "expected-archive-v1.json",
        "canonical-json-vectors-v1.json",
        "redeem-vectors-v1.json",
        "README.md",
    ]
    for name in ordered_names:
        data = (output / name).read_bytes()
        entries[name]["byte_size"] = len(data)
        entries[name]["sha256"] = sha256(data)
    index["files"] = [entries[name] for name in ordered_names]
    index_path.write_bytes(json_bytes(index))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", nargs="?", type=Path, help="private d5-specimen.db")
    parser.add_argument("capture", nargs="?", type=Path, help="private 13610-req-body")
    parser.add_argument("--output", type=Path, help="fixture output directory")
    parser.add_argument(
        "--refresh-index-only",
        action="store_true",
        help="refresh hashes for already-generated public fixture files",
    )
    args = parser.parse_args()
    output = args.output or Path(__file__).resolve().parents[3] / "crates/mc-module/tests/fixtures/d5-specimen"
    if args.refresh_index_only:
        refresh_fixture_index(output)
        print(f"refreshed deterministic D5 specimen index at {output}")
        return
    if args.db is None or args.capture is None:
        parser.error("db and capture are required unless --refresh-index-only is used")

    db_path = args.db.resolve()
    capture_path = args.capture.resolve()
    assert_digest(db_path, DB_SHA256, "source database")
    capture_bytes = assert_digest(capture_path, CAPTURE_SHA256, "13610 capture")
    probes_path = db_path.parent / "d5-content-probes.json"
    probes = load_json(probes_path.read_text())
    if not isinstance(probes, list) or len(probes) != 3:
        raise SystemExit("expected exactly three probes beside the source database")
    state = load_source_state(db_path, probes)
    capture = load_json(capture_bytes)
    raw_provider_blocks = capture_provider_block_bytes(capture_bytes)
    source_segment, manifest, archive, member_sources = build_fixture(
        state, capture, raw_provider_blocks, probes
    )
    write_fixture(output, source_segment, manifest, archive, member_sources)
    print(f"wrote deterministic D5 specimen to {output}")


if __name__ == "__main__":
    main()
