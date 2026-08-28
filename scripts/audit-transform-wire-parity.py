#!/usr/bin/env python3
"""Summarize TS/Rust/Pi parity evidence from served captures and durable rows.

Serialized provider requests remain OpenCode ground truth. Pi JSONL is source
history only; dated .pi-render.json context outputs are its served-transform
evidence. Every lane is admitted only after reading the live project config.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

RUST_SESSIONS = {
    "ses_0ad83017cffexe0g5N8UG0y3LZ",  # ENGRAM Rust transform session
    "ses_08df2045bffeBcWcqw60elghER",  # ASTROCYTE Rust transform session
}
SESSION_PATTERN = re.compile(r"-(ses_[^-]+)-")
TAG_PATTERN = re.compile(r"^§(\d+)§(?P<separator> |$)")
ANY_TAG_PATTERN = re.compile(r"§(\d+)§")
TEMPORAL_PATTERN = re.compile(r"^<!-- \+[^>]+ -->\n")
DROP_PATTERN = re.compile(r"^\[dropped(?: §\d+§)?\]$")
SYSTEM_REMINDER_FULL_PATTERN = re.compile(
    r"^\s*<system-reminder>[\s\S]*</system-reminder>\s*$", re.IGNORECASE
)
CHANNEL_REMINDER_PATTERN = re.compile(
    r"(?P<reminder>(?:\n\n|^)<system-reminder>\n"
    r"(?P<body>(?:Housekeeping(?::| backlog:)|Reminder:|Routine housekeeping:)[^\n]*"
    r"(?:\noldest reclaimable: [^\n]*)?)"
    r"\n</system-reminder>)$"
)
CHANNEL1_DENOMINATOR_PATTERN = re.compile(
    r"~(?P<amount>\d+k) of this session's ~(?P<window>\d+k) window"
)
COMPARTMENT_HEADING_PATTERN = re.compile(
    r"^## \d+-\d+(?: · \d{4}-\d{2}-\d{2}(?: → \d{4}-\d{2}-\d{2})?)? · .+$"
)
M0_SECTION_NAMES = (
    "project-docs",
    "user-profile",
    "covered-system-messages",
    "session-history",
    "project-memory",
    "memory-mural",
)
M1_SECTION_NAMES = (
    "memory-updates",
    "new-compartments",
    "new-memories",
    "new-user-profile",
    "new-notes",
)
MAGIC_CONTEXT_MARKER = "## Magic Context"
DATE_LINE_PATTERN = re.compile(r"^\s*Today's date: .+$", re.MULTILINE)
TEMPORAL_TAG_PATTERN = re.compile(r"^<!-- \+[^>]+ -->\n§\d+§(?: |$)")
TAG_TEMPORAL_PATTERN = re.compile(r"^§\d+§ <!-- \+[^>]+ -->\n")
TRANSPORT_TEMPORAL_PATTERN = re.compile(
    r"^(?:§\d+§ )?<!-- \+[^>]+ -->\n\s*<system-reminder>"
)
M1_PLACEHOLDER_TEXT = "(no new content since last materialization)"
M1_PLACEHOLDER_WRAPPED = (
    "<session-history-since>"
    + M1_PLACEHOLDER_TEXT
    + "</session-history-since>"
)
COMPACTION_MARKER_PATTERN = re.compile(
    r"^(?:§(?P<tag>\d+)§ )?\[Compacted by magic-context — "
    r"session history is managed by the plugin\]$"
)
SEARCH_HINT_DROP_PATTERN = re.compile(
    r"^\[dropped §(?P<tag>\d+)§\]\n\n<ctx-search-hint>[\s\S]*</ctx-search-hint>$"
)
TRUNCATION_SENTINEL = "...[truncated]"
EDIT_TOOL_NAMES = {"edit", "write", "mcp_edit", "mcp_write"}
EDIT_DIFF_KEYS = {"content", "newstring", "oldstring", "patch", "diff"}
WORKING_DIRECTORY_PATTERN = re.compile(r"^Working directory: (?P<path>.+)$", re.MULTILINE)
TRANSFORM_MODE_PATTERN = re.compile(r'"transform_mode"\s*:\s*"(?P<mode>ts|rust)"')
CTX_FACADE_NAMES = {"ctx_expand", "ctx_note", "ctx_search"}


@dataclass(frozen=True)
class Dump:
    path: Path
    session: str
    lane: str
    body: dict[str, Any]
    response: dict[str, Any] | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump_dir", type=Path, nargs="?")
    parser.add_argument(
        "--live",
        action="store_true",
        help="run the privacy-preserving consolidation probe against live host state",
    )
    parser.add_argument("--date", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    parser.add_argument("--per-session", type=int, default=6)
    parser.add_argument(
        "--engine-after",
        help="UTC/offset ISO lower bound for hunt-6 engine evidence in --live mode",
    )
    parser.add_argument(
        "--after",
        help="include dump filenames at or after this UTC timestamp prefix",
    )
    parser.add_argument(
        "--before",
        help="include dump filenames at or before this UTC timestamp prefix",
    )
    parser.add_argument(
        "--rust-session",
        action="append",
        dest="rust_sessions",
        help="assert an expected Rust session (repeatable; config still decides its lane)",
    )
    parser.add_argument(
        "--project-config",
        action="append",
        default=[],
        metavar="PROJECT_ROOT=CONFIG_PATH",
        help="override <root>/.cortexkit/magic-context.jsonc for lane verification",
    )
    parser.add_argument(
        "--context-db",
        type=Path,
        help="read-only context.db for caveman and transform-decision evidence",
    )
    parser.add_argument(
        "--store-db",
        type=Path,
        help="read-only Rust store.db for module activity and scheduler evidence",
    )
    parser.add_argument(
        "--store-root",
        type=Path,
        help="root containing live mc-store databases used by --live",
    )
    parser.add_argument(
        "--opencode-db",
        type=Path,
        help="read-only OpenCode database used by --live",
    )
    parser.add_argument(
        "--rpc-root",
        type=Path,
        help="Magic Context RPC discovery root used by --live",
    )
    parser.add_argument(
        "--skip-live-rpc",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--skip-live-rust-oracle",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--pi-session-dir",
        type=Path,
        help="read-only Pi JSONL session root (normally ~/.pi/agent/sessions)",
    )
    parser.add_argument(
        "--pi-render-dir",
        type=Path,
        help="directory of YYYY-MM-DD*.pi-render.json context-output captures",
    )
    parser.add_argument(
        "--omp-session-dir",
        type=Path,
        help="read-only OMP JSONL session root for shared-listing evidence",
    )
    parser.add_argument(
        "--window-report-ledger",
        type=Path,
        help="read-only window-reports.jsonl overflow ledger",
    )
    parser.add_argument("--indent", type=int, default=2)
    return parser.parse_args()


def session_from_name(path: Path) -> str | None:
    match = SESSION_PATTERN.search(path.name)
    return match.group(1) if match else None


def choose_paths(
    root: Path,
    date: str,
    per_session: int,
    after: str | None = None,
    before: str | None = None,
) -> list[Path]:
    grouped: dict[str, list[Path]] = collections.defaultdict(list)
    for path in root.glob(f"{date}*.body.json"):
        if after is not None and path.name < after:
            continue
        if before is not None and path.name > before:
            continue
        session = session_from_name(path)
        if session is not None:
            grouped[session].append(path)
    return [
        path
        for session in sorted(grouped)
        for path in sorted(grouped[session])[-per_session:]
    ]


def load_dumps(paths: Iterable[Path], rust_sessions: set[str]) -> list[Dump]:
    dumps = []
    for path in paths:
        session = session_from_name(path)
        if session is None:
            continue
        response_path = path.with_name(path.name.replace(".body.json", ".response.json"))
        response = json.loads(response_path.read_text()) if response_path.exists() else None
        dumps.append(
            Dump(
                path=path,
                session=session,
                lane="rust" if session in rust_sessions else "ts",
                body=json.loads(path.read_text()),
                response=response,
            )
        )
    return dumps


def choose_pi_render_paths(root: Path, date: str, per_session: int) -> list[Path]:
    grouped: dict[str, list[Path]] = collections.defaultdict(list)
    for path in root.glob(f"{date}*.pi-render.json"):
        try:
            capture = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        session = capture.get("session_id") if isinstance(capture, dict) else None
        if isinstance(session, str) and session:
            grouped[session].append(path)
    return [
        path
        for session in sorted(grouped)
        for path in sorted(grouped[session])[-per_session:]
    ]


def pi_content_blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return []
    output: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "toolCall":
            output.append(
                {
                    "type": "tool_use",
                    "id": part.get("id"),
                    "name": part.get("name"),
                    "input": part.get("arguments", {}),
                }
            )
        elif part_type == "image":
            output.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": part.get("mimeType"),
                        "data": part.get("data"),
                    },
                }
            )
        elif part_type == "thinking":
            output.append(
                {
                    "type": "thinking",
                    "thinking": part.get("thinking", ""),
                    **(
                        {"signature": part["thinkingSignature"]}
                        if isinstance(part.get("thinkingSignature"), str)
                        else {}
                    ),
                }
            )
        else:
            output.append(dict(part))
    return output


def normalize_pi_render_messages(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return []
    output: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "toolResult":
            output.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.get("toolCallId"),
                            "content": pi_content_blocks(message.get("content")),
                        }
                    ],
                }
            )
        elif role in ("user", "assistant", "custom"):
            output.append(
                {
                    "role": "user" if role == "custom" else role,
                    "content": pi_content_blocks(message.get("content")),
                }
            )
    return output


def load_pi_render_dumps(paths: Iterable[Path]) -> list[Dump]:
    dumps: list[Dump] = []
    for path in paths:
        try:
            capture = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(capture, dict):
            continue
        session = capture.get("session_id")
        project = capture.get("project_root")
        messages = capture.get("messages", capture.get("output_messages"))
        if not isinstance(session, str) or not session:
            continue
        system = (
            [{"type": "text", "text": f"Working directory: {project}"}]
            if isinstance(project, str) and project
            else []
        )
        dumps.append(
            Dump(
                path=path,
                session=session,
                lane="pi",
                body={"system": system, "messages": normalize_pi_render_messages(messages)},
                response=capture.get("response") if isinstance(capture.get("response"), dict) else None,
            )
        )
    return dumps


def nested_text_values(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("text", "thinking", "content") and isinstance(child, str):
                yield child
            else:
                yield from nested_text_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from nested_text_values(child)


def summarize_pi_session_sources(root: Path | None) -> dict[str, Any]:
    if root is None:
        return {
            "status": "not_requested",
            "sessions": [],
            "note": "pass --pi-session-dir to inspect real Pi JSONL source entries",
        }
    sessions: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*.jsonl")):
        entry_types: collections.Counter[str] = collections.Counter()
        tag_placements: collections.Counter[str] = collections.Counter()
        message_entries = 0
        missing_entry_ids = 0
        channel_nudges = 0
        session_id: str | None = None
        project_root: str | None = None
        clone_parent: str | None = None
        errors: list[str] = []
        try:
            lines = path.read_text().splitlines()
        except OSError as error:
            sessions.append({"file": str(path), "error": str(error)})
            continue
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as error:
                errors.append(f"line {line_number}: {error.msg}")
                continue
            if not isinstance(entry, dict):
                continue
            entry_type = str(entry.get("type", "unknown"))
            entry_types[entry_type] += 1
            if entry_type == "session":
                session_id = next(
                    (
                        value
                        for key in ("id", "sessionId", "session_id")
                        if isinstance((value := entry.get(key)), str) and value
                    ),
                    session_id,
                )
                project_root = next(
                    (
                        value
                        for key in ("cwd", "projectRoot", "project_root")
                        if isinstance((value := entry.get(key)), str) and value
                    ),
                    project_root,
                )
                clone_parent = next(
                    (
                        value
                        for key in ("parentSession", "parentSessionId", "parent_session_id")
                        if isinstance((value := entry.get(key)), str) and value
                    ),
                    clone_parent,
                )
            if entry_type == "message":
                message_entries += 1
                if not isinstance(entry.get("id"), str) or not entry.get("id"):
                    missing_entry_ids += 1
            for text in nested_text_values(entry):
                placement, _ = tag_placement(text)
                tag_placements[placement] += 1
                reminder = reminder_shape(text)
                if reminder is not None:
                    channel_nudges += 1
        sessions.append(
            {
                "file": str(path),
                "session_id": session_id,
                "project_root": project_root,
                "clone_parent": clone_parent,
                "entry_types": counter_dict(entry_types),
                "message_entries": message_entries,
                "missing_entry_ids": missing_entry_ids,
                "tag_placements": counter_dict(tag_placements),
                "channel_nudges": channel_nudges,
                "errors": errors[:10],
            }
        )
    return {
        "status": "ok",
        "sessions": sessions,
        "totals": {
            "files": len(sessions),
            "message_entries": sum(row.get("message_entries", 0) for row in sessions),
            "missing_entry_ids": sum(row.get("missing_entry_ids", 0) for row in sessions),
            "clones": sum(bool(row.get("clone_parent")) for row in sessions),
        },
        "rule": "JSONL is source evidence; only .pi-render.json captures enter served-output comparisons",
    }


def summarize_omp_session_sources(root: Path | None) -> dict[str, Any]:
    summary = summarize_pi_session_sources(root)
    if root is None:
        summary["note"] = "pass --omp-session-dir to inspect real OMP JSONL source entries"
    else:
        summary["rule"] = (
            "OMP uses the Pi-compatible JSONL reader; source rows prove listing coverage, "
            "not served output"
        )
    return summary


def blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict)]


def text_fields(block: dict[str, Any]) -> Iterable[tuple[str, str]]:
    for key in ("text", "thinking"):
        value = block.get(key)
        if isinstance(value, str):
            yield key, value
    content = block.get("content")
    if isinstance(content, str):
        yield "content", content
    elif isinstance(content, list):
        for index, child in enumerate(content):
            if isinstance(child, dict) and isinstance(child.get("text"), str):
                yield f"content[{index}].text", child["text"]


def short(value: str, limit: int = 180) -> str:
    return value[:limit].replace("\n", "\\n")


def evidence(dump: Dump, message_index: int, block_index: int, value: str) -> dict[str, Any]:
    return {
        "session": dump.session,
        "file": dump.path.name,
        "message": message_index,
        "block": block_index,
        "excerpt": short(value),
    }


def counter_dict(
    counter: collections.Counter[Any], limit: int | None = None
) -> dict[str, int]:
    rows = sorted(counter.items(), key=lambda item: (-item[1], str(item[0])))
    if limit is not None:
        rows = rows[:limit]
    return {str(key): value for key, value in rows}


def json_paths(value: Any, path: str = "input") -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield from json_paths(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from json_paths(child, f"{path}[{index}]")
    else:
        yield path, value


def raw_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()[:16]


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def starts_section(value: str, name: str) -> bool:
    return re.match(rf"^<{re.escape(name)}(?:>| )", value) is not None


def section_start(value: str, name: str, offset: int = 0) -> int:
    match = re.search(rf"(?m)^<{re.escape(name)}(?:>| )", value[offset:])
    return -1 if match is None else offset + match.start()


def classify_text_field(
    role: Any,
    block_type: Any,
    field: str,
    value: str,
    message_index: int,
) -> str:
    if role == "user" and message_index == 0 and block_type == "text":
        if any(starts_section(value, name) for name in M0_SECTION_NAMES):
            return "synthetic_m0"
        if value.startswith("<session-history-since>"):
            return "synthetic_m1"
    if role == "user" and block_type == "tool_result":
        return "tool_result_text"
    if role == "user" and block_type == "text":
        body = TAG_PATTERN.sub("", value, count=1)
        body = TEMPORAL_PATTERN.sub("", body, count=1)
        if SYSTEM_REMINDER_FULL_PATTERN.fullmatch(body):
            return "user_transport_reminder"
        return "user_text"
    if role == "assistant" and block_type == "text":
        return "assistant_text"
    if block_type in ("thinking", "reasoning", "redacted_thinking"):
        return "assistant_reasoning"
    return f"{role}_{block_type}_{field}"


def tag_placement(value: str) -> tuple[str, int | None]:
    prefix = TAG_PATTERN.match(value)
    if prefix:
        separator = "space" if prefix.group("separator") == " " else "eof"
        return f"prefix_{separator}", len(prefix.group(1))
    if ANY_TAG_PATTERN.search(value):
        return "embedded_or_suffix", None
    return "absent", None


def ordered_sections(value: str, names: tuple[str, ...]) -> tuple[str, ...]:
    positions = [
        (position, name)
        for name in names
        if (position := section_start(value, name)) >= 0
    ]
    return tuple(name for _, name in sorted(positions))


def section_separators(value: str, order: tuple[str, ...]) -> tuple[str, ...]:
    separators: list[str] = []
    search_offset = 0
    for left, right in zip(order, order[1:]):
        left_start = section_start(value, left, search_offset)
        close = f"</{left}>"
        left_end = value.find(close, left_start)
        right_start = section_start(value, right, left_end + len(close))
        if left_start < 0 or left_end < 0 or right_start < 0:
            separators.append("unresolved")
            continue
        between = value[left_end + len(close) : right_start]
        separators.append(repr(between))
        search_offset = right_start
    return tuple(separators)


def section_body(value: str, name: str) -> str | None:
    start = section_start(value, name)
    if start < 0:
        return None
    opener_end = value.find(">", start)
    close_start = value.find(f"</{name}>", opener_end + 1)
    if opener_end < 0 or close_start < 0:
        return None
    return value[opener_end + 1 : close_start]


def normalized_channel1_template(reminder: str) -> str:
    normalized = re.sub(r"~\d+k", "~<tokens>", reminder)
    normalized = re.sub(r"\b\d+ spent tool outputs?\b", "<count> spent tool outputs", normalized)
    normalized = re.sub(
        r"\noldest reclaimable: [^\n]*\.(?=\n</system-reminder>)",
        "\noldest reclaimable: <hint>.",
        normalized,
    )
    return normalized


def reminder_shape(value: str) -> tuple[str, str, str, bool, str] | None:
    match = CHANNEL_REMINDER_PATTERN.search(value)
    if match is None:
        return None
    body = match.group("body")
    first_line = body.splitlines()[0]
    if first_line.startswith("Routine housekeeping:"):
        channel = "channel2"
        band = "ceiling"
    elif first_line.startswith("Reminder:"):
        channel = "channel1"
        band = "sticky"
    elif first_line.startswith("Housekeeping backlog:"):
        channel = "channel1"
        band = "urgent"
    elif "drop the ones" in first_line or "some earlier tool outputs" in first_line:
        channel = "channel1"
        band = "gentle"
    else:
        channel = "channel1"
        band = "firm"
    version = "degauged" if " are reclaimable —" in first_line else "gauged"
    placement = "full" if match.start("reminder") == 0 else "suffix"
    return channel, band, version, "\noldest reclaimable:" in body, placement


def tool_reduction_shape(name: Any, tool_input: dict[str, Any]) -> str:
    if "reduced" in tool_input or "summary" in tool_input:
        return "reduced_envelope"
    normalized_name = str(name).lower()
    for key, value in tool_input.items():
        if (
            normalized_name in EDIT_TOOL_NAMES
            and key.lower() in EDIT_DIFF_KEYS
            and isinstance(value, str)
            and TRUNCATION_SENTINEL in value
        ):
            return "edit_marker"
    if any(
        isinstance(value, str) and TRUNCATION_SENTINEL in value
        for _, value in json_paths(tool_input)
    ):
        return "skeleton"
    return "full_or_small"


def provider_wire_family(body: dict[str, Any]) -> str:
    if isinstance(body.get("input"), list) and isinstance(body.get("instructions"), str):
        return "openai_responses"
    if isinstance(body.get("contents"), list):
        return "gemini"
    messages = body.get("messages")
    if not isinstance(messages, list):
        return "unknown"
    if isinstance(body.get("system"), list):
        return "anthropic"
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, list) and any(
            isinstance(block, dict)
            and block.get("type")
            in ("tool_use", "tool_result", "thinking", "redacted_thinking")
            for block in content
        ):
            return "anthropic"
    return "openai_compatible"


def provider_system_entries(body: dict[str, Any], family: str) -> list[Any]:
    if family == "anthropic":
        system = body.get("system")
        return list(system) if isinstance(system, list) else []
    if family == "openai_responses":
        instructions = body.get("instructions")
        return [{"text": instructions}] if isinstance(instructions, str) else []
    if family == "openai_compatible":
        messages = body.get("messages")
        if not isinstance(messages, list):
            return []
        return [
            message
            for message in messages
            if isinstance(message, dict) and message.get("role") == "system"
        ]
    if family == "gemini":
        system = body.get("systemInstruction", body.get("system_instruction"))
        return [system] if isinstance(system, dict) else []
    return []


def project_root(body: dict[str, Any]) -> str | None:
    family = provider_wire_family(body)
    for item in provider_system_entries(body, family):
        for text in nested_text_values(item):
            match = WORKING_DIRECTORY_PATTERN.search(text)
            if match:
                return match.group("path")
    return None


def provider_label(dump: Dump, family: str) -> str:
    for source in (dump.response, dump.body):
        if not isinstance(source, dict):
            continue
        for key in ("provider_id", "providerID", "provider"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip().lower()
    if family == "anthropic" and "anthropic_version" in dump.body:
        return "bedrock"
    model = dump.body.get("model")
    if isinstance(model, str):
        lowered = model.lower()
        for marker, label in (
            ("moonshot", "moonshot"),
            ("kimi", "moonshot"),
            ("qwen", "qwen"),
            ("gemini", "google"),
            ("gpt", "openai"),
        ):
            if marker in lowered:
                return label
        if family == "anthropic" and "claude" in lowered:
            return "anthropic"
    return f"{family}_unknown_provider"


def provider_wire_messages(body: dict[str, Any], family: str) -> list[dict[str, Any]]:
    key = "contents" if family == "gemini" else "input" if family == "openai_responses" else "messages"
    messages = body.get(key)
    if not isinstance(messages, list):
        return []
    if family == "openai_compatible":
        return [
            message
            for message in messages
            if isinstance(message, dict) and message.get("role") != "system"
        ]
    return [message for message in messages if isinstance(message, dict)]


def provider_message_role(message: dict[str, Any], family: str) -> str:
    role = message.get("role")
    if family == "openai_responses" and not isinstance(role, str):
        item_type = message.get("type")
        if item_type in ("function_call", "reasoning"):
            return "assistant"
        if item_type == "function_call_output":
            return "tool"
    if family == "gemini" and role == "model":
        return "assistant"
    return str(role) if isinstance(role, str) else "unknown"


def provider_message_texts(message: dict[str, Any], family: str) -> list[str]:
    values = list(nested_text_values(message))
    if family == "openai_responses" and isinstance(message.get("output"), str):
        values.append(message["output"])
    if family == "openai_compatible":
        reasoning = message.get("reasoning_content")
        if isinstance(reasoning, str):
            values.append(reasoning)
    return values


def provider_tool_ids(
    message: dict[str, Any], family: str
) -> tuple[list[str], list[str]]:
    calls: list[str] = []
    results: list[str] = []
    if family == "openai_responses":
        item_type = message.get("type")
        call_id = message.get("call_id")
        if item_type == "function_call" and isinstance(call_id, str) and call_id:
            calls.append(call_id)
        if item_type == "function_call_output" and isinstance(call_id, str) and call_id:
            results.append(call_id)
        return calls, results
    if family == "openai_compatible":
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list):
            for call in tool_calls:
                if not isinstance(call, dict):
                    continue
                call_id = call.get("id")
                if isinstance(call_id, str) and call_id:
                    calls.append(call_id)
        if message.get("role") == "tool":
            result_id = message.get("tool_call_id")
            if isinstance(result_id, str) and result_id:
                results.append(result_id)
        return calls, results

    parts_key = "parts" if family == "gemini" else "content"
    parts = message.get(parts_key)
    if not isinstance(parts, list):
        return calls, results
    for part in parts:
        if not isinstance(part, dict):
            continue
        if family == "anthropic":
            if part.get("type") == "tool_use" and isinstance(part.get("id"), str):
                calls.append(part["id"])
            if part.get("type") == "tool_result" and isinstance(part.get("tool_use_id"), str):
                results.append(part["tool_use_id"])
            continue
        function_call = part.get("functionCall")
        if isinstance(function_call, dict):
            call_id = function_call.get("id", function_call.get("name"))
            if isinstance(call_id, str) and call_id:
                calls.append(call_id)
        function_response = part.get("functionResponse")
        if isinstance(function_response, dict):
            result_id = function_response.get("id", function_response.get("name"))
            if isinstance(result_id, str) and result_id:
                results.append(result_id)
    return calls, results


def provider_reasoning_shapes(message: dict[str, Any], family: str) -> list[str]:
    shapes: list[str] = []
    if family == "openai_responses" and message.get("type") == "reasoning":
        signed = isinstance(message.get("encrypted_content"), str) and bool(
            message.get("encrypted_content")
        )
        summary = message.get("summary")
        summary_count = len(summary) if isinstance(summary, list) else 0
        return [
            f"reasoning_item:signed={str(signed).lower()};summary_parts={summary_count}"
        ]
    if family == "openai_compatible":

        reasoning = message.get("reasoning_content")
        if isinstance(reasoning, str):
            signed = any(
                isinstance(message.get(key), str) and bool(message.get(key))
                for key in ("reasoning_signature", "thinking_signature", "signature")
            )
            shapes.append(f"reasoning_content:signed={str(signed).lower()}")
        content = message.get("content")
        parts = content if isinstance(content, list) else []
    else:
        parts_key = "parts" if family == "gemini" else "content"
        raw_parts = message.get(parts_key)
        parts = raw_parts if isinstance(raw_parts, list) else []
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        if family == "gemini":
            if part.get("thought") is not True and "thoughtSignature" not in part:
                continue
            signed = isinstance(part.get("thoughtSignature"), str) and bool(
                part.get("thoughtSignature")
            )
            shapes.append(f"thought@{index}:signed={str(signed).lower()}")
            continue
        block_type = part.get("type")
        if block_type not in (
            "thinking",
            "reasoning",
            "redacted_thinking",
            "redacted_reasoning",
        ):
            continue
        metadata = part.get("metadata")
        metadata_signed = isinstance(metadata, dict) and any(
            "signature" in path.lower() and isinstance(value, str) and bool(value)
            for path, value in json_paths(metadata, "metadata")
        )
        signed = any(
            isinstance(part.get(key), str) and bool(part.get(key))
            for key in ("signature", "thinkingSignature", "thoughtSignature")
        ) or metadata_signed
        shapes.append(f"{block_type}@{index}:signed={str(signed).lower()}")
    return shapes


def openai_responses_tool_adjacency(
    messages: list[dict[str, Any]], allow_external_result_owner: bool
) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    index = 0
    while index < len(messages):
        calls, results = provider_tool_ids(messages[index], "openai_responses")
        if calls:
            owner_index = index
            expected: list[str] = []
            while index < len(messages):
                current_calls, _ = provider_tool_ids(messages[index], "openai_responses")
                if not current_calls:
                    break
                expected.extend(current_calls)
                index += 1
            actual: list[str] = []
            while index < len(messages):
                _, current_results = provider_tool_ids(messages[index], "openai_responses")
                if not current_results:
                    break
                actual.extend(current_results)
                index += 1
            missing = sorted(set(expected) - set(actual))
            unexpected = sorted(set(actual) - set(expected))
            if missing or unexpected:
                violations.append(
                    {
                        "message_index": owner_index,
                        "missing_result_ids": missing,
                        "unexpected_result_ids": unexpected,
                        "orphan_result_ids": [],
                    }
                )
            continue
        if results and not allow_external_result_owner:
            violations.append(
                {
                    "message_index": index,
                    "missing_result_ids": [],
                    "unexpected_result_ids": [],
                    "orphan_result_ids": sorted(set(results)),
                }
            )
        index += 1
    return violations


def provider_tool_adjacency(
    messages: list[dict[str, Any]],
    family: str,
    allow_external_result_owner: bool = False,
) -> list[dict[str, Any]]:
    if family == "openai_responses":
        return openai_responses_tool_adjacency(messages, allow_external_result_owner)
    violations: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        calls, _ = provider_tool_ids(message, family)
        if not calls:
            continue
        collected: list[str] = []
        cursor = index + 1
        while cursor < len(messages):
            _, results = provider_tool_ids(messages[cursor], family)
            if not results:
                break
            collected.extend(results)
            cursor += 1
        missing = [call_id for call_id in calls if call_id not in collected]
        unexpected = [result_id for result_id in collected if result_id not in calls]
        if missing or unexpected:
            violations.append(
                {
                    "message_index": index,
                    "missing_result_ids": missing,
                    "unexpected_result_ids": unexpected,
                    "following_roles": [
                        provider_message_role(candidate, family)
                        for candidate in messages[index + 1 : index + 4]
                    ],
                }
            )
    for index, message in enumerate(messages):
        _, results = provider_tool_ids(message, family)
        if not results:
            continue
        cursor = index - 1
        while cursor >= 0 and provider_tool_ids(messages[cursor], family)[1]:
            cursor -= 1
        owner_calls = (
            provider_tool_ids(messages[cursor], family)[0] if cursor >= 0 else []
        )
        orphaned = [result_id for result_id in results if result_id not in owner_calls]
        if orphaned and allow_external_result_owner and not owner_calls:
            continue
        if orphaned:
            violations.append(
                {
                    "message_index": index,
                    "orphan_result_ids": orphaned,
                    "preceding_roles": [
                        provider_message_role(candidate, family)
                        for candidate in messages[max(0, index - 3) : index]
                    ],
                }
            )
    return violations


def summarize_provider_dump(dump: Dump) -> dict[str, Any]:
    family = provider_wire_family(dump.body)
    provider = provider_label(dump, family)
    messages = provider_wire_messages(dump.body, family)
    systems = provider_system_entries(dump.body, family)
    empty_shapes: set[str] = set()
    dropped_shapes: set[str] = set()
    reasoning_shapes: set[str] = set()
    calls = 0
    results = 0
    for index, message in enumerate(messages):
        role = provider_message_role(message, family)
        call_ids, result_ids = provider_tool_ids(message, family)
        calls += len(call_ids)
        results += len(result_ids)
        texts = provider_message_texts(message, family)
        has_empty_text = any(value == "" for value in texts)
        content = message.get("parts" if family == "gemini" else "content")
        content_empty = (
            content in (None, "", []) and not call_ids and not result_ids
            if family != "openai_responses" or message.get("type") in (None, "message")
            else False
        )
        if has_empty_text or content_empty:
            empty_shapes.add(
                f"role={role};empty_text={str(has_empty_text).lower()};empty_message={str(content_empty).lower()}"
            )
        if any(DROP_PATTERN.fullmatch(value.strip()) for value in texts):
            previous_calls = (
                provider_tool_ids(messages[index - 1], family)[0] if index > 0 else []
            )
            next_results = (
                provider_tool_ids(messages[index + 1], family)[1]
                if index + 1 < len(messages)
                else []
            )
            if previous_calls and next_results:
                position = "between_call_and_result"
            elif index + 1 < len(messages) and provider_tool_ids(
                messages[index + 1], family
            )[0]:
                position = "before_tool_call"
            elif index > 0 and provider_tool_ids(messages[index - 1], family)[1]:
                position = "after_tool_result"
            else:
                position = "isolated"
            dropped_shapes.add(f"role={role};position={position}")
        for shape in provider_reasoning_shapes(message, family):
            reasoning_shapes.add(f"role={role};{shape}")
    adjacency = provider_tool_adjacency(
        messages,
        family,
        allow_external_result_owner=(
            family == "openai_responses"
            and isinstance(dump.body.get("previous_response_id"), str)
            and bool(dump.body.get("previous_response_id"))
        ),
    )
    system_message_count = 1 if family == "anthropic" and systems else len(systems)
    invariants: list[str] = []
    if family in ("openai_compatible", "openai_responses", "gemini") and system_message_count > 1:
        invariants.append("multiple_system_messages_for_strict_template")
    canonical_anthropic = provider == "anthropic" and family == "anthropic"
    if not canonical_anthropic and empty_shapes:
        invariants.append("non_anthropic_empty_content")
    if adjacency:
        invariants.append("tool_result_adjacency_violation")
    return {
        "file": dump.path.name,
        "session": dump.session,
        "lane": dump.lane,
        "provider": provider,
        "wire_family": family,
        "provider_family": f"{provider}:{family}",
        "message_count": len(messages),
        "system_message_count": system_message_count,
        "system_block_count": len(systems),
        "empty_content_shapes": sorted(empty_shapes) or ["none"],
        "dropped_placeholder_shapes": sorted(dropped_shapes) or ["none"],
        "tool_pairing_shapes": [
            f"calls={calls};results={results};adjacency={'invalid' if adjacency else 'valid'}"
        ],
        "reasoning_signature_shapes": sorted(reasoning_shapes) or ["none"],
        "adjacency_violations": adjacency,
        "unexplained_invariants": invariants,
    }


def compare_provider_matrix(dumps: list[Dump]) -> dict[str, Any]:
    rows = [
        summarize_provider_dump(dump)
        for dump in dumps
        if dump.lane in ("ts", "rust")
    ]
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = collections.defaultdict(
        lambda: collections.defaultdict(list)
    )
    for row in rows:
        grouped[row["provider_family"]][row["lane"]].append(row)
    fields = (
        "empty_content_shapes",
        "dropped_placeholder_shapes",
        "system_message_count",
        "system_block_count",
        "tool_pairing_shapes",
        "reasoning_signature_shapes",
    )
    axes: list[dict[str, Any]] = []
    for provider_family, lanes in sorted(grouped.items()):
        for field in fields:
            def value_space(lane: str) -> set[str]:
                space: set[str] = set()
                for row in lanes.get(lane, []):
                    value = row[field]
                    if isinstance(value, list):
                        space.update(str(item) for item in value)
                    else:
                        space.add(str(value))
                return space

            ts_space = value_space("ts")
            rust_space = value_space("rust")
            if not ts_space or not rust_space:
                verdict = "evidence_gap"
            elif ts_space == rust_space:
                verdict = "matched_value_space"
            else:
                verdict = "divergent_value_space"
            axes.append(
                {
                    "provider_family": provider_family,
                    "axis": field,
                    "verdict": verdict,
                    "ts_only": sorted(ts_space - rust_space),
                    "rust_only": sorted(rust_space - ts_space),
                    "shared": sorted(ts_space & rust_space),
                }
            )
    unexplained_invariants = [
        {
            "file": row["file"],
            "session": row["session"],
            "lane": row["lane"],
            "provider_family": row["provider_family"],
            "classes": row["unexplained_invariants"],
            "adjacency_violations": row["adjacency_violations"],
        }
        for row in rows
        if row["unexplained_invariants"]
    ]
    return {
        "inventory_by_lane": {
            lane: counter_dict(
                collections.Counter(
                    row["provider_family"] for row in rows if row["lane"] == lane
                )
            )
            for lane in ("ts", "rust")
        },
        "axes": axes,
        "unexplained_byte_classes": [
            axis for axis in axes if axis["verdict"] == "divergent_value_space"
        ],
        "unexplained_wire_invariants": unexplained_invariants,
        "evidence": rows,
        "note": "provider families compare observed per-leg value spaces; counts from unlike sessions are inventory only",
    }


def strip_jsonc_comments(value: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(value):
        char = value[index]
        next_char = value[index + 1] if index + 1 < len(value) else ""
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == "/" and next_char == "/":
            index += 2
            while index < len(value) and value[index] not in "\r\n":
                index += 1
            continue
        if char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(value) and value[index : index + 2] != "*/":
                index += 1
            index = min(len(value), index + 2)
            continue
        output.append(char)
        index += 1
    return "".join(output)


def project_config_overrides(values: Iterable[str]) -> dict[str, Path]:
    overrides: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"project config override must be ROOT=PATH: {value}")
        root, path = value.split("=", 1)
        if not root or not path:
            raise ValueError(f"project config override must be ROOT=PATH: {value}")
        overrides[str(Path(root).expanduser())] = Path(path).expanduser()
    return overrides


def configured_transform_mode(path: Path) -> tuple[str | None, str | None]:
    try:
        text = path.read_text()
    except OSError as error:
        return None, str(error)
    match = TRANSFORM_MODE_PATTERN.search(strip_jsonc_comments(text))
    return (match.group("mode") if match else "ts"), None


def verify_dump_lanes(
    dumps: list[Dump],
    expected_rust_sessions: set[str],
    overrides: dict[str, Path],
) -> tuple[list[Dump], dict[str, Any]]:
    verified: list[Dump] = []
    rows: dict[tuple[str, str | None], dict[str, Any]] = {}
    for dump in dumps:
        root = project_root(dump.body)
        config_path = (
            overrides.get(str(Path(root).expanduser()))
            if root is not None
            else None
        )
        if config_path is None and root is not None:
            config_path = Path(root).expanduser() / ".cortexkit" / "magic-context.jsonc"
        mode, error = (
            configured_transform_mode(config_path)
            if config_path is not None
            else (None, "project root unavailable in served system bytes")
        )
        configured_lane = mode if mode in ("rust", "ts") else "unverified"
        claimed_lane = "rust" if dump.session in expected_rust_sessions else "ts"
        status = (
            "verified"
            if configured_lane == claimed_lane
            else "label_corrected_from_live_config"
            if configured_lane != "unverified"
            else "unverified"
        )
        verified.append(
            Dump(
                path=dump.path,
                session=dump.session,
                lane=configured_lane,
                body=dump.body,
                response=dump.response,
            )
        )
        key = (dump.session, root)
        row = rows.setdefault(
            key,
            {
                "session": dump.session,
                "project_root": root,
                "config_path": str(config_path) if config_path is not None else None,
                "claimed_lane": claimed_lane,
                "configured_lane": configured_lane,
                "status": status,
                "error": error,
                "dump_count": 0,
            },
        )
        row["dump_count"] += 1
    return verified, {
        "sessions": sorted(rows.values(), key=lambda row: (row["session"], row["project_root"] or "")),
        "denominator_dump_counts": dict(
            sorted(collections.Counter(dump.lane for dump in verified).items())
        ),
        "rule": "only dumps whose live project config was readable enter rust/ts denominators",
    }


def verify_pi_render_configs(
    dumps: list[Dump], overrides: dict[str, Path]
) -> tuple[list[Dump], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    verified: list[Dump] = []
    for dump in dumps:
        root = project_root(dump.body)
        config_path = overrides.get(str(Path(root).expanduser())) if root is not None else None
        if config_path is None and root is not None:
            config_path = Path(root).expanduser() / ".cortexkit" / "magic-context.jsonc"
        configured_lane, error = (
            configured_transform_mode(config_path)
            if config_path is not None
            else (None, "project root unavailable in Pi render capture")
        )
        status = "verified" if configured_lane in ("rust", "ts") else "unverified"
        if status == "verified":
            verified.append(dump)
        rows.append(
            {
                "session": dump.session,
                "project_root": root,
                "config_path": str(config_path) if config_path is not None else None,
                "opencode_transform_mode": configured_lane,
                "effective_lane": "pi" if status == "verified" else "unverified",
                "status": status,
                "error": error,
                "dump_count": 1,
            }
        )
    return verified, {
        "sessions": rows,
        "denominator_dump_counts": {"pi": len(verified)} if verified else {},
        "rule": "Pi remains its own TS harness lane; a readable live project config is required, while transform_mode describes only OpenCode authority",
    }


def media_shape(message_index: int, role: Any, block: dict[str, Any]) -> tuple[Any, ...] | None:
    block_type = block.get("type")
    if block_type not in ("image", "document", "file", "attachment"):
        return None
    source = block.get("source")
    source_keys = tuple(sorted(source)) if isinstance(source, dict) else ()
    location = "m0_mural" if message_index == 0 and block_type == "image" else "transcript"
    return (
        location,
        role,
        block_type,
        tuple(sorted(block)),
        source.get("type") if isinstance(source, dict) else None,
        source.get("media_type") if isinstance(source, dict) else None,
        source_keys,
    )


def parse_bound(value: str | None, date: str, end: bool = False) -> int:
    if value:
        filename_stamp = re.match(
            r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z", value
        )
        stamp = filename_stamp.group(0) if filename_stamp else value
        formats = (
            "%Y-%m-%dT%H-%M-%S-%fZ",
            "%Y-%m-%dT%H-%M-%S",
            "%Y-%m-%dT%H-%M",
            "%Y-%m-%dT%H",
        )
        for format_string in formats:
            try:
                parsed = dt.datetime.strptime(stamp, format_string).replace(
                    tzinfo=dt.timezone.utc
                )
                return int(parsed.timestamp() * 1000)
            except ValueError:
                continue
        raise ValueError(f"unsupported timestamp bound: {value}")
    day = dt.datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    if end:
        day += dt.timedelta(days=1)
    return int(day.timestamp() * 1000)


def table_columns(db: sqlite3.Connection, table: str) -> list[str]:
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if exists is None:
        return []
    quoted = table.replace('"', '""')
    return [str(row[1]) for row in db.execute(f'PRAGMA table_info("{quoted}")')]


def fetch_dicts(
    db: sqlite3.Connection, sql: str, parameters: tuple[Any, ...] = ()
) -> list[dict[str, Any]]:
    cursor = db.execute(sql, parameters)
    names = [str(column[0]) for column in cursor.description or ()]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def table_exists(db: sqlite3.Connection, table: str) -> bool:
    return (
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        is not None
    )


def session_table_inventory(db: sqlite3.Connection) -> list[str]:
    tables = [
        str(row[0])
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    return sorted(table for table in tables if "session_id" in table_columns(db, table))


def scoped_table_rows(
    db: sqlite3.Connection,
    table: str,
    columns: Iterable[str],
    sessions: set[str],
    start_ms: int,
    end_ms: int,
    created_column: str | None,
) -> tuple[list[str], list[dict[str, Any]]]:
    available = table_columns(db, table)
    selected = [column for column in columns if column in available]
    if not available or "session_id" not in available or not sessions:
        return available, []
    placeholders = ",".join("?" for _ in sessions)
    predicates = [f"session_id IN ({placeholders})"]
    parameters: list[Any] = list(sorted(sessions))
    if created_column is not None and created_column in available:
        predicates.append(f"{created_column} >= ? AND {created_column} < ?")
        parameters.extend((start_ms, end_ms))
    quoted = table.replace('"', '""')
    projection = ", ".join(f'"{column}"' for column in selected)
    return available, fetch_dicts(
        db,
        f'SELECT {projection} FROM "{quoted}" WHERE {" AND ".join(predicates)} ORDER BY session_id',
        tuple(parameters),
    )


def summarize_historian_rows(
    db: sqlite3.Connection,
    lane: str,
    sessions: set[str],
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    compartment_table = "mc_compartments" if lane == "rust" else "compartments"
    compartment_columns, compartments = scoped_table_rows(
        db,
        compartment_table,
        (
            "session_id",
            "sequence",
            "start_message",
            "end_message",
            "start_date",
            "end_date",
            "p1",
            "p2",
            "p3",
            "p4",
            "importance",
            "legacy",
            "created_at",
        ),
        sessions,
        start_ms,
        end_ms,
        "created_at",
    )
    tier_columns = [column for column in ("p1", "p2", "p3", "p4") if column in compartment_columns]
    importance = [
        int(row["importance"])
        for row in compartments
        if isinstance(row.get("importance"), int)
    ]
    date_columns = [
        column for column in ("start_date", "end_date") if column in compartment_columns
    ]
    compartment_summary = {
        "table": compartment_table,
        "columns": compartment_columns,
        "rows_born_in_window": len(compartments),
        "sessions": counter_dict(
            collections.Counter(row.get("session_id") for row in compartments)
        ),
        "tier_complete_rows": sum(
            all(isinstance(row.get(column), str) and bool(row[column]) for column in tier_columns)
            for row in compartments
        )
        if len(tier_columns) == 4
        else None,
        "legacy_rows": sum(row.get("legacy") == 1 for row in compartments),
        "importance": {
            "min": min(importance) if importance else None,
            "max": max(importance) if importance else None,
            "average": round(sum(importance) / len(importance), 3) if importance else None,
        },
        "date_columns": date_columns,
        "complete_date_rows": sum(
            all(isinstance(row.get(column), str) and bool(row[column]) for column in date_columns)
            for row in compartments
        )
        if len(date_columns) == 2
        else None,
        "samples": [
            {
                "session": row.get("session_id"),
                "sequence": row.get("sequence"),
                "range": [row.get("start_message"), row.get("end_message")],
                "tier_presence": [bool(row.get(column)) for column in tier_columns],
                "importance": row.get("importance"),
                "legacy": row.get("legacy"),
                "dates": [row.get("start_date"), row.get("end_date")]
                if date_columns
                else "derived_from_raw_messages_at_ts_render_time",
                "created_at": row.get("created_at"),
            }
            for row in compartments[:12]
        ],
    }

    memory_table = "mc_memories" if lane == "rust" else "memories"
    memory_columns, facts = scoped_table_rows(
        db,
        memory_table,
        (
            "session_id",
            "source_session_id",
            "category",
            "content",
            "importance",
            "source_type",
            "created_at",
        ),
        sessions,
        start_ms,
        end_ms,
        "created_at",
    )
    if "source_session_id" in memory_columns and sessions:
        placeholders = ",".join("?" for _ in sessions)
        projection = ", ".join(
            f'"{column}"'
            for column in (
                "source_session_id",
                "category",
                "content",
                "importance",
                "source_type",
                "created_at",
            )
            if column in memory_columns
        )
        predicates = [f"source_session_id IN ({placeholders})"]
        parameters: list[Any] = list(sorted(sessions))
        if "created_at" in memory_columns:
            predicates.append("created_at >= ? AND created_at < ?")
            parameters.extend((start_ms, end_ms))
        facts = fetch_dicts(
            db,
            f'SELECT {projection} FROM "{memory_table}" WHERE {" AND ".join(predicates)} ORDER BY source_session_id, created_at',
            tuple(parameters),
        )
    else:
        facts = []
    fact_summary = {
        "table": memory_table,
        "rows_promoted_in_window": len(facts),
        "sessions": counter_dict(
            collections.Counter(row.get("source_session_id") for row in facts)
        ),
        "categories": counter_dict(collections.Counter(row.get("category") for row in facts)),
        "samples": [
            {
                "session": row.get("source_session_id"),
                "category": row.get("category"),
                "content_sha256_12": hashlib.sha256(
                    str(row.get("content", "")).encode()
                ).hexdigest()[:12],
                "content_bytes": len(str(row.get("content", "")).encode()),
                "importance": row.get("importance"),
                "source_type": row.get("source_type"),
                "created_at": row.get("created_at"),
            }
            for row in facts[:12]
        ],
    }

    side_table = (
        "mc_historian_side_channel_outbox" if lane == "rust" else "compartment_events"
    )
    side_columns, side_rows = scoped_table_rows(
        db,
        side_table,
        (
            "session_id",
            "kind",
            "firing_seq",
            "source_start",
            "source_end",
            "at_compartment",
            "attempt_count",
            "delivered_at_ms",
            "last_error",
            "created_at",
            "created_at_ms",
        ),
        sessions,
        start_ms,
        end_ms,
        "created_at_ms" if lane == "rust" else "created_at",
    )
    side_summary = {
        "table": side_table,
        "columns": side_columns,
        "rows_born_in_window": len(side_rows),
        "kinds": counter_dict(collections.Counter(row.get("kind") for row in side_rows)),
        "pending_delivery_rows": sum(
            "delivered_at_ms" in row and row.get("delivered_at_ms") is None for row in side_rows
        ),
        "failed_delivery_rows": sum(bool(row.get("last_error")) for row in side_rows),
    }
    return {
        "compartments": compartment_summary,
        "promoted_facts": fact_summary,
        "historian_side_effects": side_summary,
        "session_id_tables": session_table_inventory(db),
        "session_delete_coverage": (
            "dynamic: session.delete deletes every live table with an exact session_id column"
            if lane == "rust"
            else "static shared table list; storage-db lockstep test compares it to this schema inventory"
        ),
    }


def observed_authority_lanes(
    context_db: Path | None,
    store_db: Path | None,
    sessions: set[str],
    start_ms: int,
    end_ms: int,
) -> dict[str, str]:
    operand_rows: collections.Counter[str] = collections.Counter()
    if context_db is not None and sessions:
        placeholders = ",".join("?" for _ in sessions)
        with sqlite3.connect(f"file:{context_db}?mode=ro", uri=True) as db:
            rows = db.execute(
                f"""SELECT session_id, system_hash_prev, system_hash_new,
                           m0_model_key_prev, m0_model_key_new,
                           m0_tool_set_hash_prev, m0_tool_set_hash_new
                      FROM transform_decisions
                     WHERE session_id IN ({placeholders}) AND ts_ms >= ? AND ts_ms < ?""",
                (*sorted(sessions), start_ms, end_ms),
            ).fetchall()
        for session, *operands in rows:
            if any(value is not None for value in operands):
                operand_rows[str(session)] += 1
    module_active: set[str] = set()
    if store_db is not None and sessions:
        placeholders = ",".join("?" for _ in sessions)
        with sqlite3.connect(f"file:{store_db}?mode=ro", uri=True) as db:
            rows = db.execute(
                f"SELECT session_id, last_activity_at FROM mc_cache_state WHERE session_id IN ({placeholders})",
                tuple(sorted(sessions)),
            ).fetchall()
        module_active = {
            str(session)
            for session, last_activity in rows
            if isinstance(last_activity, int) and start_ms <= last_activity < end_ms
        }
    return {
        session: (
            "ts"
            if operand_rows[session] > 0
            else "rust"
            if session in module_active
            else "unknown"
        )
        for session in sessions
    }


def apply_observed_lanes(
    dumps: list[Dump],
    verification: dict[str, Any],
    observed: dict[str, str],
) -> list[Dump]:
    effective: list[Dump] = []
    for dump in dumps:
        observed_lane = observed.get(dump.session, "unknown")
        lane = (
            observed_lane
            if dump.lane in ("rust", "ts") and observed_lane in ("rust", "ts")
            else dump.lane
        )
        effective.append(
            Dump(
                path=dump.path,
                session=dump.session,
                lane=lane,
                body=dump.body,
                response=dump.response,
            )
        )
    for row in verification["sessions"]:
        observed_lane = observed.get(row["session"], "unknown")
        row["observed_lane"] = observed_lane
        row["effective_lane"] = (
            observed_lane
            if row["configured_lane"] in ("rust", "ts")
            and observed_lane in ("rust", "ts")
            else row["configured_lane"]
        )
        if (
            row["configured_lane"] in ("rust", "ts")
            and observed_lane in ("rust", "ts")
            and observed_lane != row["configured_lane"]
        ):
            row["status"] = "config_and_durable_authority_disagree"
    verification["denominator_dump_counts"] = dict(
        sorted(collections.Counter(dump.lane for dump in effective).items())
    )
    verification["rule"] = (
        "read live project config first; decisive in-window durable authority then selects the effective denominator"
    )
    return effective


def summarize_engine_adjacent_state(
    context_db: Path | None,
    store_db: Path | None,
    sessions: set[str],
    lane_by_session: dict[str, str],
) -> dict[str, Any]:
    """Inventory lane-neutral read models and Rust engine truth without dumping content."""

    per_session: dict[str, dict[str, Any]] = {
        session: {"configured_lane": lane_by_session.get(session, "unverified")}
        for session in sorted(sessions)
    }

    def count(
        db: sqlite3.Connection, sql: str, parameters: tuple[Any, ...]
    ) -> int:
        row = db.execute(sql, parameters).fetchone()
        return int(row[0]) if row is not None else 0

    if context_db is not None:
        with sqlite3.connect(f"file:{context_db}?mode=ro", uri=True) as db:
            for session in sorted(sessions):
                row = per_session[session]
                if table_exists(db, "message_history_index"):
                    columns = table_columns(db, "message_history_index")
                    selected = [
                        column
                        for column in (
                            "last_indexed_ordinal",
                            "dirty_floor_ordinal",
                            "harness",
                        )
                        if column in columns
                    ]
                    projection = ", ".join(selected)
                    state = (
                        fetch_dicts(
                            db,
                            f"SELECT {projection} FROM message_history_index WHERE session_id = ?",
                            (session,),
                        )
                        if selected
                        else []
                    )
                else:
                    state = []
                if table_exists(db, "message_history_fts"):
                    fts = {
                        "rows": count(
                            db,
                            "SELECT COUNT(*) FROM message_history_fts WHERE session_id = ?",
                            (session,),
                        ),
                        "distinct_message_ids": count(
                            db,
                            "SELECT COUNT(DISTINCT message_id) FROM message_history_fts WHERE session_id = ?",
                            (session,),
                        ),
                        "empty_content_rows": count(
                            db,
                            "SELECT COUNT(*) FROM message_history_fts WHERE session_id = ? AND content = ''",
                            (session,),
                        ),
                    }
                else:
                    fts = None
                row["message_index"] = {"state": state, "fts": fts}

                bindings = (
                    fetch_dicts(
                        db,
                        "SELECT harness, project_path FROM session_projects WHERE session_id = ? ORDER BY harness, project_path",
                        (session,),
                    )
                    if table_exists(db, "session_projects")
                    else []
                )
                row["session_project_bindings"] = bindings

                embedding: dict[str, Any] = {}
                if table_exists(db, "compartments"):
                    embedding["compartments"] = count(
                        db, "SELECT COUNT(*) FROM compartments WHERE session_id = ?", (session,)
                    )
                if table_exists(db, "compartment_chunk_embeddings"):
                    embedding["chunk_vectors"] = count(
                        db,
                        "SELECT COUNT(*) FROM compartment_chunk_embeddings WHERE session_id = ?",
                        (session,),
                    )
                    if table_exists(db, "session_projects"):
                        embedding["mis_scoped_chunk_vectors"] = count(
                            db,
                            """SELECT COUNT(*)
                                 FROM compartment_chunk_embeddings e
                                 JOIN session_projects sp
                                   ON sp.session_id = e.session_id AND sp.harness = e.harness
                                WHERE e.session_id = ? AND e.project_path <> sp.project_path""",
                            (session,),
                        )
                if table_exists(db, "memories") and "source_session_id" in table_columns(
                    db, "memories"
                ):
                    embedding["memories"] = count(
                        db, "SELECT COUNT(*) FROM memories WHERE source_session_id = ?", (session,)
                    )
                    if table_exists(db, "memory_embeddings"):
                        embedding["memory_vectors"] = count(
                            db,
                            """SELECT COUNT(*) FROM memory_embeddings e
                                 JOIN memories m ON m.id = e.memory_id
                                WHERE m.source_session_id = ?""",
                            (session,),
                        )
                row["embeddings"] = embedding

                if table_exists(db, "notes"):
                    note_columns = table_columns(db, "notes")
                    predicates = ["session_id = ?"]
                    if "type" in note_columns:
                        predicates.append("type = 'smart'")
                    projection = ["status"]
                    if "check_status" in note_columns:
                        projection.append("check_status")
                    note_rows = fetch_dicts(
                        db,
                        f"SELECT {', '.join(projection)}, COUNT(*) AS count FROM notes WHERE {' AND '.join(predicates)} GROUP BY {', '.join(projection)} ORDER BY {', '.join(projection)}",
                        (session,),
                    )
                else:
                    note_rows = []
                row["smart_notes"] = note_rows

                if table_exists(db, "git_commits") and bindings:
                    projects = sorted(
                        {
                            str(binding["project_path"])
                            for binding in bindings
                            if binding.get("project_path") is not None
                        }
                    )
                    placeholders = ",".join("?" for _ in projects)
                    row["git_commits"] = (
                        count(
                            db,
                            f"SELECT COUNT(*) FROM git_commits WHERE project_path IN ({placeholders})",
                            tuple(projects),
                        )
                        if projects
                        else 0
                    )

    if store_db is not None:
        with sqlite3.connect(f"file:{store_db}?mode=ro", uri=True) as db:
            for session in sorted(sessions):
                truth: dict[str, Any] = {}
                for table, preferred in (
                    (
                        "mc_cache_state",
                        (
                            "row_version",
                            "last_activity_at",
                        ),
                    ),
                    (
                        "mc_pass_trace",
                        (
                            "last_received_at_ms",
                            "last_completed_at_ms",
                            "last_reject_error",
                            "last_reject_at_ms",
                            "receive_count",
                            "reject_count",
                            "first_divergence",
                        ),
                    ),
                ):
                    if not table_exists(db, table):
                        truth[table] = None
                        continue
                    available = table_columns(db, table)
                    selected = [column for column in preferred if column in available]
                    projection = ", ".join(selected) if selected else "session_id"
                    values = fetch_dicts(
                        db,
                        f"SELECT {projection} FROM {table} WHERE session_id = ?",
                        (session,),
                    )
                    truth[table] = values
                row = per_session[session]
                row["rust_engine_truth"] = truth

    coverage_by_lane: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for session, row in per_session.items():
        message_state = row.get("message_index", {}).get("state", [])
        embedding = row.get("embeddings", {})
        coverage_by_lane[str(row["configured_lane"])].append(
            {
                "session": session,
                "message_index_present": bool(message_state),
                "message_index_dirty": any(
                    state.get("dirty_floor_ordinal") not in (None, 0) for state in message_state
                ),
                "session_project_bound": bool(row.get("session_project_bindings")),
                "chunk_vectors_present": embedding.get("chunk_vectors", 0) > 0,
                "memory_vectors_present": embedding.get("memory_vectors", 0) > 0,
                "smart_notes_present": bool(row.get("smart_notes")),
                "git_commits_present": row.get("git_commits", 0) > 0,
            }
        )
    unexplained_invariants = [
        {
            "session": session,
            "class": "duplicate_message_fts_rows",
            "rows": fts["rows"],
            "distinct_message_ids": fts["distinct_message_ids"],
        }
        for session, row in per_session.items()
        if (fts := row.get("message_index", {}).get("fts"))
        and fts["rows"] != fts["distinct_message_ids"]
    ] + [
        {
            "session": session,
            "class": "mis_scoped_chunk_vectors",
            "count": row.get("embeddings", {}).get("mis_scoped_chunk_vectors"),
        }
        for session, row in per_session.items()
        if row.get("embeddings", {}).get("mis_scoped_chunk_vectors", 0) > 0
    ]
    return {
        "per_session": per_session,
        "coverage_by_lane": dict(sorted(coverage_by_lane.items())),
        "unexplained_invariants": unexplained_invariants,
        "note": "counts inventory durable coverage only; parity verdicts require identical histories and per-leg value-space adjudication",
    }


def summarize_operator_read_state(
    context_db: Path | None,
    store_db: Path | None,
    sessions: set[str],
    lane_by_session: dict[str, str],
) -> dict[str, Any]:
    """Inventory the exact durable fields consumed by doctor, RPC, and sidebar reads."""

    per_session: dict[str, dict[str, Any]] = {
        session: {"configured_lane": lane_by_session.get(session, "unverified")}
        for session in sorted(sessions)
    }
    storage_versions: dict[str, int | None] = {
        "context_db_schema_version": None,
        "module_store_schema_version": None,
    }

    def scalar(db: sqlite3.Connection, sql: str, parameters: tuple[Any, ...] = ()) -> int:
        row = db.execute(sql, parameters).fetchone()
        return int(row[0]) if row is not None and row[0] is not None else 0

    def json_object(value: Any) -> dict[str, Any]:
        if not isinstance(value, str):
            return {}
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    project_paths_by_session: dict[str, list[str]] = collections.defaultdict(list)
    if context_db is not None:
        with sqlite3.connect(f"file:{context_db}?mode=ro", uri=True) as db:
            if table_exists(db, "schema_migrations"):
                storage_versions["context_db_schema_version"] = scalar(
                    db,
                    "SELECT COALESCE(MAX(version), 0) FROM schema_migrations WHERE version < 10000",
                )
            for session in sorted(sessions):
                row = per_session[session]
                context: dict[str, Any] = {}
                if table_exists(db, "session_meta"):
                    available = table_columns(db, "session_meta")
                    selected = [
                        column
                        for column in (
                            "last_context_percentage",
                            "last_input_tokens",
                            "last_usage_context_limit",
                            "cache_ttl",
                            "last_response_time",
                            "counter",
                            "cached_m0_mural_hash",
                        )
                        if column in available
                    ]
                    context["session_meta"] = (
                        fetch_dicts(
                            db,
                            f"SELECT {', '.join(selected)} FROM session_meta WHERE session_id = ?",
                            (session,),
                        )
                        if selected
                        else []
                    )
                if table_exists(db, "tags"):
                    available = table_columns(db, "tags")
                    tag_counts: dict[str, Any] = {
                        "total": scalar(
                            db, "SELECT COUNT(*) FROM tags WHERE session_id = ?", (session,)
                        )
                    }
                    if "status" in available:
                        tag_counts["by_status"] = fetch_dicts(
                            db,
                            "SELECT status, COUNT(*) AS count FROM tags WHERE session_id = ? GROUP BY status ORDER BY status",
                            (session,),
                        )
                    if "byte_size" in available and "status" in available:
                        tag_counts["active_bytes"] = scalar(
                            db,
                            "SELECT COALESCE(SUM(byte_size), 0) FROM tags WHERE session_id = ? AND status = 'active'",
                            (session,),
                        )
                    context["tags"] = tag_counts
                if table_exists(db, "compartments"):
                    context["compartment_count"] = scalar(
                        db, "SELECT COUNT(*) FROM compartments WHERE session_id = ?", (session,)
                    )
                if table_exists(db, "session_projects"):
                    project_paths = [
                        str(binding["project_path"])
                        for binding in fetch_dicts(
                            db,
                            "SELECT project_path FROM session_projects WHERE session_id = ? ORDER BY project_path",
                            (session,),
                        )
                        if binding.get("project_path") is not None
                    ]
                    project_paths_by_session[session] = project_paths
                    context["project_paths"] = project_paths
                if table_exists(db, "mural_manifest"):
                    murals: list[dict[str, Any]] = []
                    available = table_columns(db, "mural_manifest")
                    selected = [
                        column
                        for column in (
                            "project_path",
                            "content_hash",
                            "rendered_at",
                            "width",
                            "height",
                            "memory_ids_json",
                        )
                        if column in available
                    ]
                    for project_path in project_paths_by_session[session]:
                        murals.extend(
                            fetch_dicts(
                                db,
                                f"SELECT {', '.join(selected)} FROM mural_manifest WHERE project_path = ?",
                                (project_path,),
                            )
                            if selected
                            else []
                        )
                    context["mural_manifest"] = murals
                row["context_read_model"] = context

    mural_invariants: list[dict[str, Any]] = []
    if store_db is not None:
        with sqlite3.connect(f"file:{store_db}?mode=ro", uri=True) as db:
            if table_exists(db, "cortexkit_schema_version"):
                storage_versions["module_store_schema_version"] = scalar(
                    db,
                    "SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version WHERE namespace = 'mc_cache'",
                )
            for session in sorted(sessions):
                row = per_session[session]
                module: dict[str, Any] = {}
                if table_exists(db, "mc_cache_state"):
                    available = table_columns(db, "mc_cache_state")
                    selected = [
                        column
                        for column in ("row_version", "last_activity_at", "meta")
                        if column in available
                    ]
                    states = (
                        fetch_dicts(
                            db,
                            f"SELECT {', '.join(selected)} FROM mc_cache_state WHERE session_id = ?",
                            (session,),
                        )
                        if selected
                        else []
                    )
                    module["cache_state"] = [
                        {
                            **{
                                key: value
                                for key, value in state.items()
                                if key != "meta"
                            },
                            "last_usage": json_object(state.get("meta")).get("last_usage"),
                            "initialized": json_object(state.get("meta")).get("initialized"),
                        }
                        for state in states
                    ]
                for table, field in (
                    ("mc_compartments", "compartment_count"),
                    ("mc_tags", "tag_count"),
                    ("pending_agent_drops", "pending_drop_count"),
                ):
                    module[field] = (
                        scalar(db, f"SELECT COUNT(*) FROM {table} WHERE session_id = ?", (session,))
                        if table_exists(db, table)
                        else None
                    )
                if table_exists(db, "mc_pass_trace"):
                    available = table_columns(db, "mc_pass_trace")
                    selected = [
                        column
                        for column in (
                            "last_received_at_ms",
                            "last_completed_at_ms",
                            "last_reject_error",
                            "last_reject_at_ms",
                            "receive_count",
                            "reject_count",
                        )
                        if column in available
                    ]
                    traces = (
                        fetch_dicts(
                            db,
                            f"SELECT {', '.join(selected)} FROM mc_pass_trace WHERE session_id = ?",
                            (session,),
                        )
                        if selected
                        else []
                    )
                    module["pass_trace"] = [
                        {
                            **{
                                key: value
                                for key, value in trace.items()
                                if key != "last_reject_error"
                            },
                            "last_reject_error": (
                                {
                                    "present": True,
                                    "bytes": len(str(trace["last_reject_error"]).encode()),
                                    "sha256": text_hash(str(trace["last_reject_error"])),
                                }
                                if trace.get("last_reject_error")
                                else {"present": False}
                            ),
                        }
                        for trace in traces
                    ]
                if table_exists(db, "mc_project_mural_artifacts"):
                    artifacts: list[dict[str, Any]] = []
                    for project_path in project_paths_by_session[session]:
                        values = fetch_dicts(
                            db,
                            "SELECT project_path, content_hash, length(data_url) AS data_url_bytes, updated_at FROM mc_project_mural_artifacts WHERE project_path = ?",
                            (project_path,),
                        )
                        artifacts.extend(values)
                    module["mural_artifacts"] = artifacts
                    host_hashes = {
                        str(value["content_hash"])
                        for value in row.get("context_read_model", {}).get(
                            "mural_manifest", []
                        )
                        if value.get("content_hash") is not None
                    }
                    module_hashes = {
                        str(value["content_hash"])
                        for value in artifacts
                        if value.get("content_hash") is not None
                    }
                    if host_hashes and module_hashes and host_hashes != module_hashes:
                        mural_invariants.append(
                            {
                                "session": session,
                                "class": "mural_artifact_hash_mismatch",
                                "host_hashes": sorted(host_hashes),
                                "module_hashes": sorted(module_hashes),
                            }
                        )
                row["module_read_model"] = module

    for row in per_session.values():
        lane = row["configured_lane"]
        row["operator_truth_sources"] = (
            {
                "usage": "module_read_model",
                "compartment_count": "module_read_model",
                "tag_count": "module_read_model",
                "pending_drop_count": "module_read_model",
                "mural": "module_read_model",
                "cache_ttl": "context_read_model",
            }
            if lane == "rust"
            else {
                "usage": "context_read_model",
                "compartment_count": "context_read_model",
                "tag_count": "context_read_model",
                "pending_drop_count": "context_read_model",
                "mural": "context_read_model",
                "cache_ttl": "context_read_model",
            }
        )
    return {
        "storage_versions": storage_versions,
        "per_session": per_session,
        "unexplained_invariants": mural_invariants,
        "field_contract": {
            "rust": "usage, compartment totals, tag totals, pending drops, and mural inclusion come from mc-store; cache TTL timing remains host-owned",
            "ts": "usage, compartment/tag totals, cache TTL timing, and mural manifest come from context.db",
            "doctor": "context.db and mc-store have independent storage-version and repair domains",
        },
        "note": "rows are an inventory; compare values only for the same session/history and preserve unavailable Rust active/dropped tag breakdowns as unavailable",
    }


def summarize_window_report_ledger(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {
            "status": "not_requested",
            "note": "pass --window-report-ledger to inspect overflow report row shapes",
        }
    key_shapes: collections.Counter[tuple[str, ...]] = collections.Counter()
    geometries: collections.Counter[str] = collections.Counter()
    statuses: collections.Counter[str] = collections.Counter()
    errors: list[str] = []
    rows = 0
    try:
        lines = path.read_text().splitlines()
    except OSError as error:
        return {"status": "unreadable", "error": str(error)}
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            errors.append(f"line {line_number}: {error.msg}")
            continue
        if not isinstance(value, dict):
            errors.append(f"line {line_number}: row is not an object")
            continue
        rows += 1
        key_shapes[tuple(sorted(str(key) for key in value))] += 1
        geometries[str(value.get("geometry", "missing"))] += 1
        statuses[str(value.get("status", "missing"))] += 1
    return {
        "status": "ok",
        "rows": rows,
        "key_shapes": counter_dict(key_shapes),
        "geometries": counter_dict(geometries),
        "statuses": counter_dict(statuses),
        "parse_errors": errors[:20],
        "note": "the event handler owns this ledger before transform authority branches, so lane parity is row-shape parity for the same provider event",
    }


def summarize_telemetry(
    context_db: Path | None,
    store_db: Path | None,
    sessions: set[str],
    lane_by_session: dict[str, str],
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    report: dict[str, Any] = {}
    transform_rows: dict[str, list[tuple[Any, ...]]] = collections.defaultdict(list)
    if context_db is not None:
        with sqlite3.connect(f"file:{context_db}?mode=ro", uri=True) as db:
            placeholders = ",".join("?" for _ in sessions)
            if sessions:
                rows = db.execute(
                    f"""SELECT session_id, ts_ms, decision, materialize_reason,
                               input_tokens, emergency, dropped_count,
                               system_hash_prev, system_hash_new,
                               m0_model_key_prev, m0_model_key_new,
                               m0_tool_set_hash_prev, m0_tool_set_hash_new
                          FROM transform_decisions
                         WHERE session_id IN ({placeholders}) AND ts_ms >= ? AND ts_ms < ?
                         ORDER BY ts_ms""",
                    (*sorted(sessions), start_ms, end_ms),
                ).fetchall()
                for row in rows:
                    transform_rows[str(row[0])].append(tuple(row[1:]))
            caveman_rows = db.execute(
                """SELECT session_id, caveman_depth, COUNT(*), MIN(tag_number), MAX(tag_number)
                       FROM tags WHERE caveman_depth > 0
                      GROUP BY session_id, caveman_depth ORDER BY session_id, caveman_depth"""
            ).fetchall()
            report["ts_historian_rows"] = summarize_historian_rows(
                db,
                "ts",
                {session for session in sessions if lane_by_session.get(session) == "ts"},
                start_ms,
                end_ms,
            )
        report["caveman_depth_state"] = [
            {
                "session": row[0],
                "depth": row[1],
                "count": row[2],
                "min_tag": row[3],
                "max_tag": row[4],
            }
            for row in caveman_rows
            if row[0] in sessions
        ]

    module_activity: dict[str, dict[str, Any]] = {}
    if store_db is not None:
        with sqlite3.connect(f"file:{store_db}?mode=ro", uri=True) as db:
            placeholders = ",".join("?" for _ in sessions)
            if sessions:
                for session, last_activity, meta in db.execute(
                    f"SELECT session_id, last_activity_at, meta FROM mc_cache_state WHERE session_id IN ({placeholders})",
                    tuple(sorted(sessions)),
                ):
                    parsed_meta = json.loads(meta)
                    module_activity[str(session)] = {
                        "last_activity_at_ms": last_activity,
                        "last_activity_in_window": start_ms <= last_activity < end_ms,
                        "active_since_window_start": last_activity >= start_ms,
                        "caveman_age_basis_tag": parsed_meta.get("caveman_age_basis_tag"),
                    }
                scheduler_rows = db.execute(
                    f"SELECT session_id, scheduler_history, scheduler_interesting_history FROM mc_pass_trace WHERE session_id IN ({placeholders})",
                    tuple(sorted(sessions)),
                ).fetchall()
            else:
                scheduler_rows = []
            report["rust_historian_rows"] = summarize_historian_rows(
                db,
                "rust",
                {session for session in sessions if lane_by_session.get(session) == "rust"},
                start_ms,
                end_ms,
            )
        scheduler_report: dict[str, Any] = {}
        for session, history_json, interesting_json in scheduler_rows:
            history = [
                row
                for row in json.loads(history_json)
                if start_ms <= row.get("timestamp_ms", -1) < end_ms
            ]
            interesting = [
                row
                for row in json.loads(interesting_json)
                if start_ms <= row.get("timestamp_ms", -1) < end_ms
            ]
            scheduler_report[str(session)] = {
                "decisions": counter_dict(
                    collections.Counter(row.get("scheduler_decision") for row in history)
                ),
                "interesting_decisions": counter_dict(
                    collections.Counter(row.get("scheduler_decision") for row in interesting)
                ),
                "interesting_predicates": counter_dict(
                    collections.Counter(
                        (
                            row.get("scheduler_decision"),
                            row.get("drain_latch_active"),
                            row.get("eligible_supersession_count"),
                            row.get("applied_supersession_count"),
                            row.get("withheld_by_tag_window"),
                            row.get("withheld_by_exempt_message"),
                        )
                        for row in interesting
                    )
                ),
            }
        report["rust_scheduler"] = scheduler_report
        report["module_activity"] = module_activity

    decision_report: dict[str, Any] = {}
    matched_bands: dict[str, collections.Counter[Any]] = {
        "rust": collections.Counter(),
        "ts": collections.Counter(),
    }
    for session in sorted(sessions):
        rows = transform_rows.get(session, [])
        operand_rows = sum(any(value is not None for value in row[6:]) for row in rows)
        module_active = module_activity.get(session, {}).get(
            "last_activity_in_window", False
        )
        observed_lane = (
            "rust"
            if module_active and operand_rows == 0
            else "ts"
            if operand_rows > 0
            else "unknown"
        )
        decisions = collections.Counter(row[1] for row in rows)
        reasons = collections.Counter(row[2] for row in rows)
        decision_report[session] = {
            "configured_lane": lane_by_session.get(session, "unverified"),
            "observed_lane": observed_lane,
            "rows": len(rows),
            "rows_with_ts_only_operands": operand_rows,
            "module_active_since_window_start": module_active,
            "decisions": counter_dict(decisions),
            "materialize_reasons": counter_dict(reasons),
        }
        for row in rows:
            input_band = f"{int(row[3]) // 50_000 * 50}k-{(int(row[3]) // 50_000 + 1) * 50}k"
            if observed_lane in matched_bands:
                matched_bands[observed_lane][
                    (input_band, row[1], row[2], bool(row[4]), row[5])
                ] += 1
    report["transform_decisions_by_session"] = decision_report
    report["matched_input_predicates"] = {
        lane: counter_dict(counter) for lane, counter in matched_bands.items()
    }
    return report


def summarize_lane(dumps: list[Dump]) -> dict[str, Any]:
    sessions = collections.Counter(dump.session for dump in dumps)
    response_statuses: collections.Counter[Any] = collections.Counter()
    response_usage_bands: collections.Counter[Any] = collections.Counter()
    max_response_total_input = -1
    max_response_usage: dict[str, Any] | None = None
    system_shapes: collections.Counter[Any] = collections.Counter()
    system_compositions: collections.Counter[Any] = collections.Counter()
    guidance_suffixes: collections.Counter[Any] = collections.Counter()
    head_shapes: collections.Counter[Any] = collections.Counter()
    m0_section_orders: collections.Counter[Any] = collections.Counter()
    m0_section_separators: collections.Counter[Any] = collections.Counter()
    m1_section_orders: collections.Counter[Any] = collections.Counter()
    m1_section_separators: collections.Counter[Any] = collections.Counter()
    compartment_heading_shapes: collections.Counter[Any] = collections.Counter()
    assistant_orders: collections.Counter[Any] = collections.Counter()
    trailing_shapes: collections.Counter[Any] = collections.Counter()
    text_classes: collections.Counter[Any] = collections.Counter()
    tag_classes: collections.Counter[Any] = collections.Counter()
    tag_placements: collections.Counter[Any] = collections.Counter()
    tag_prefix_formats: collections.Counter[Any] = collections.Counter()
    temporal_classes: collections.Counter[Any] = collections.Counter()
    temporal_tag_orders: collections.Counter[Any] = collections.Counter()
    reminder_temporal_classes: collections.Counter[Any] = collections.Counter()
    channel1_reminder_shapes: collections.Counter[Any] = collections.Counter()
    channel1_template_shapes: collections.Counter[Any] = collections.Counter()
    channel1_denominators: collections.Counter[Any] = collections.Counter()
    m1_placeholders: collections.Counter[Any] = collections.Counter()
    tool_input_shapes: collections.Counter[Any] = collections.Counter()
    reduced_envelopes: collections.Counter[Any] = collections.Counter()
    tool_special_values: collections.Counter[Any] = collections.Counter()
    tool_reduction_arc_shapes: collections.Counter[Any] = collections.Counter()
    tool_reduction_vocabulary: collections.Counter[Any] = collections.Counter()
    skeleton_recency: collections.Counter[Any] = collections.Counter()
    placeholder_values: collections.Counter[Any] = collections.Counter()
    drop_shapes: collections.Counter[Any] = collections.Counter()
    compaction_marker_shapes: collections.Counter[Any] = collections.Counter()
    nudge_assembly_shapes: collections.Counter[Any] = collections.Counter()
    media_shapes: collections.Counter[Any] = collections.Counter()
    project_roots: collections.Counter[Any] = collections.Counter()
    thinking_shapes: collections.Counter[Any] = collections.Counter()
    reasoning_order_shapes: collections.Counter[Any] = collections.Counter()
    newest_assistant_reasoning_presence: collections.Counter[Any] = collections.Counter()
    newest_assistant_reasoning_shapes: collections.Counter[Any] = collections.Counter()
    cache_placements: collections.Counter[Any] = collections.Counter()
    message_block_key_shapes: collections.Counter[Any] = collections.Counter()
    anomalies: collections.Counter[Any] = collections.Counter()
    special_evidence: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    todo_observations: dict[str, list[tuple[str, int, str]]] = collections.defaultdict(list)

    for dump in dumps:
        response_status = (
            dump.response.get("status") if isinstance(dump.response, dict) else "missing"
        )
        response_statuses[response_status] += 1
        if response_status != 200 and len(special_evidence["non_200_response"]) < 12:
            special_evidence["non_200_response"].append(
                evidence(dump, -1, -1, f"response={dump.response}")
            )
        response_usage = (
            dump.response.get("usage")
            if isinstance(dump.response, dict) and isinstance(dump.response.get("usage"), dict)
            else None
        )
        if response_usage is not None:
            total_input = sum(
                value
                for key in (
                    "input_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                )
                if isinstance((value := response_usage.get(key)), int)
            )
            if total_input >= 900_000:
                usage_band = ">=900k"
            elif total_input >= 750_000:
                usage_band = "750k-900k"
            elif total_input >= 500_000:
                usage_band = "500k-750k"
            elif total_input >= 250_000:
                usage_band = "250k-500k"
            else:
                usage_band = "<250k"
            response_usage_bands[usage_band] += 1
            if total_input > max_response_total_input:
                max_response_total_input = total_input
                max_response_usage = evidence(
                    dump,
                    -1,
                    -1,
                    f"total_input={total_input} usage={response_usage}",
                )
            if total_input >= 750_000 and len(special_evidence["high_pressure_usage"]) < 12:
                special_evidence["high_pressure_usage"].append(
                    evidence(
                        dump,
                        -1,
                        -1,
                        f"total_input={total_input} usage={response_usage}",
                    )
                )

        body = dump.body
        root = project_root(body)
        if root is not None:
            project_roots[(dump.session, root)] += 1
        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        system = body.get("system")
        if isinstance(system, list):
            system_shapes[
                (
                    len(system),
                    tuple(tuple(sorted(item)) for item in system if isinstance(item, dict)),
                    tuple(
                        index
                        for index, item in enumerate(system)
                        if isinstance(item, dict) and "cache_control" in item
                    ),
                )
            ] += 1
            guidance_indexes: list[int] = []
            date_indexes: list[int] = []
            guidance_separator_shapes: list[str] = []
            for index, item in enumerate(system):
                if not isinstance(item, dict):
                    continue
                if "cache_control" in item:
                    cache_placements[("system", index, item.get("type"))] += 1
                text = item.get("text")
                if not isinstance(text, str):
                    continue
                marker_index = text.find(MAGIC_CONTEXT_MARKER)
                if marker_index >= 0:
                    guidance_indexes.append(index)
                    separator = text[max(0, marker_index - 2) : marker_index]
                    guidance_separator_shapes.append(repr(separator))
                    suffix = text[marker_index:]
                    suffix_hash = text_hash(suffix)
                    guidance_suffixes[(index, suffix_hash, len(suffix), short(suffix, 120))] += 1
                    if len(special_evidence["system_guidance"]) < 6:
                        special_evidence["system_guidance"].append(
                            evidence(
                                dump,
                                -1,
                                index,
                                text[max(0, marker_index - 2) : marker_index + 220],
                            )
                        )
                if DATE_LINE_PATTERN.search(text):
                    date_indexes.append(index)
            system_compositions[
                (
                    len(system),
                    tuple(guidance_indexes),
                    tuple(date_indexes),
                    tuple(guidance_separator_shapes),
                    sum(
                        item.get("text", "").count(MAGIC_CONTEXT_MARKER)
                        for item in system
                        if isinstance(item, dict) and isinstance(item.get("text"), str)
                    ),
                )
            ] += 1
        else:
            system_shapes[(type(system).__name__,)] += 1

        head_shapes[
            tuple(
                (
                    message.get("role"),
                    tuple(block.get("type") for block in blocks(message)),
                )
                for message in messages[:4]
                if isinstance(message, dict)
            )
        ] += 1
        if messages and isinstance(messages[0], dict):
            for block_index, block in enumerate(blocks(messages[0])):
                value = block.get("text")
                if not isinstance(value, str):
                    continue
                if value == M1_PLACEHOLDER_TEXT:
                    m1_placeholders[("bare", block_index)] += 1
                elif value == M1_PLACEHOLDER_WRAPPED:
                    m1_placeholders[("wrapped", block_index)] += 1
                heading_bodies: list[str] = []
                if any(starts_section(value, name) for name in M0_SECTION_NAMES):
                    order = ordered_sections(value, M0_SECTION_NAMES)
                    m0_section_orders[(block_index, order)] += 1
                    m0_section_separators[(order, section_separators(value, order))] += 1
                    history_body = section_body(value, "session-history")
                    if history_body is not None:
                        heading_bodies.append(history_body)
                    if len(special_evidence["m0_layout"]) < 6:
                        special_evidence["m0_layout"].append(
                            evidence(dump, 0, block_index, value)
                        )
                if starts_section(value, "session-history-since"):
                    order = ordered_sections(value, M1_SECTION_NAMES)
                    m1_section_orders[(block_index, order or ("placeholder",))] += 1
                    if order:
                        m1_section_separators[(order, section_separators(value, order))] += 1
                    new_compartments = section_body(value, "new-compartments")
                    if new_compartments is not None:
                        heading_bodies.append(new_compartments)
                    if len(special_evidence["m1_layout"]) < 6:
                        special_evidence["m1_layout"].append(
                            evidence(dump, 0, block_index, value)
                        )
                for heading_body in heading_bodies:
                    for line in heading_body.splitlines():
                        if not line.startswith("## "):
                            continue
                        compartment_heading_shapes[
                            "valid" if COMPARTMENT_HEADING_PATTERN.fullmatch(line) else "invalid"
                        ] += 1
        trailing_shapes[
            tuple(
                (
                    message.get("role"),
                    tuple(block.get("type") for block in blocks(message)),
                )
                for message in messages[-4:]
                if isinstance(message, dict)
            )
        ] += 1

        newest_assistant = next(
            (
                (message_index, message)
                for message_index, message in reversed(list(enumerate(messages)))
                if isinstance(message, dict) and message.get("role") == "assistant"
            ),
            None,
        )
        if newest_assistant is None:
            newest_assistant_reasoning_presence["missing_assistant"] += 1
            newest_assistant_reasoning_shapes[("missing_assistant",)] += 1
        else:
            message_index, message = newest_assistant
            message_blocks = blocks(message)
            types = tuple(block.get("type") for block in message_blocks)
            reasoning_blocks = [
                (block_index, block)
                for block_index, block in enumerate(message_blocks)
                if block.get("type") in ("thinking", "reasoning", "redacted_thinking")
            ]
            presence = "present" if reasoning_blocks else "absent"
            signed_count = sum(bool(block.get("signature")) for _, block in reasoning_blocks)
            newest_assistant_reasoning_presence[presence] += 1
            newest_assistant_reasoning_shapes[
                (presence, types, len(reasoning_blocks), signed_count)
            ] += 1
            evidence_key = f"newest_assistant_reasoning_{presence}"
            if len(special_evidence[evidence_key]) < 6:
                if reasoning_blocks:
                    block_index, block = reasoning_blocks[0]
                    value = block.get("thinking", block.get("text", block.get("data", "")))
                    special_evidence[evidence_key].append(
                        evidence(dump, message_index, block_index, str(value))
                    )
                else:
                    special_evidence[evidence_key].append(
                        evidence(dump, message_index, -1, f"types={types}")
                    )

        tool_ids: collections.Counter[str] = collections.Counter()
        result_ids: collections.Counter[str] = collections.Counter()
        tool_calls: dict[str, tuple[str, str, int, int]] = {}
        tool_call_order: list[str] = []
        tool_result_shapes: dict[str, str] = {}
        previous_role = None
        for message_index, message in enumerate(messages):
            if not isinstance(message, dict):
                anomalies["non_object_message"] += 1
                continue
            role = message.get("role")
            if role == previous_role:
                anomalies[f"adjacent_role:{role}"] += 1
            previous_role = role
            message_blocks = blocks(message)
            if not message_blocks:
                anomalies[f"empty_content:{role}"] += 1
            types = tuple(block.get("type") for block in message_blocks)
            if role == "assistant":
                assistant_orders[types] += 1
                if "thinking" in types or "reasoning" in types:
                    reasoning_order_shapes[types] += 1

            for block_index, block in enumerate(message_blocks):
                block_type = block.get("type")
                message_block_key_shapes[(role, block_type, tuple(sorted(block)))] += 1
                shape = media_shape(message_index, role, block)
                if shape is not None:
                    media_shapes[shape] += 1
                    if len(special_evidence["media"]) < 12:
                        special_evidence["media"].append(
                            evidence(dump, message_index, block_index, str(shape))
                        )
                if "cache_control" in block:
                    cache_placements[("message", role, block_type)] += 1
                if block_type == "tool_use":
                    tool_id = block.get("id")
                    if isinstance(tool_id, str):
                        tool_ids[tool_id] += 1
                    tool_input = block.get("input")
                    if isinstance(tool_input, dict):
                        tool_name = block.get("name")
                        tool_input_shapes[(tool_name, tuple(sorted(tool_input)))] += 1
                        input_shape = tool_reduction_shape(tool_name, tool_input)
                        if input_shape == "reduced_envelope":
                            reduced_envelopes[
                                (
                                    tool_name,
                                    tuple(sorted(tool_input)),
                                    type(tool_input.get("reduced")).__name__,
                                    type(tool_input.get("summary")).__name__,
                                )
                            ] += 1
                        for path, value in json_paths(tool_input):
                            if isinstance(value, str) and TRUNCATION_SENTINEL in value:
                                key = (tool_name, path, TRUNCATION_SENTINEL)
                                tool_special_values[key] += 1
                                prefix = value.split(TRUNCATION_SENTINEL, 1)[0]
                                tool_reduction_vocabulary[
                                    (input_shape, tool_name, path, len(prefix), TRUNCATION_SENTINEL)
                                ] += 1
                                if len(special_evidence[f"tool_input_{input_shape}"]) < 12:
                                    special_evidence[f"tool_input_{input_shape}"].append(
                                        evidence(dump, message_index, block_index, value)
                                    )
                        if isinstance(tool_id, str):
                            tool_calls[tool_id] = (
                                str(tool_name),
                                input_shape,
                                message_index,
                                block_index,
                            )
                            tool_call_order.append(tool_id)
                    if (
                        isinstance(tool_id, str)
                        and tool_id.startswith("mc_synthetic_todo_")
                        and message_index + 1 < len(messages)
                    ):
                        pair = [message, messages[message_index + 1]]
                        todo_observations[tool_id].append(
                            (dump.path.name, message_index, raw_hash(pair))
                        )
                elif block_type == "tool_result":
                    tool_id = block.get("tool_use_id")
                    if isinstance(tool_id, str):
                        result_ids[tool_id] += 1
                        result_values = [value for _, value in text_fields(block)]
                        if any(
                            (DROP_PATTERN.fullmatch(value) and "§" in value)
                            or SEARCH_HINT_DROP_PATTERN.fullmatch(value)
                            for value in result_values
                        ):
                            tool_result_shapes[tool_id] = "tagged_dropped"
                        elif any(DROP_PATTERN.fullmatch(value) for value in result_values):
                            tool_result_shapes[tool_id] = "bare_dropped"
                        else:
                            tool_result_shapes[tool_id] = "visible"

                if block_type in ("thinking", "reasoning"):
                    thinking_shapes[
                        (
                            block_type,
                            tuple(sorted(block)),
                            bool(block.get("signature")),
                            "nonempty" if block.get("thinking", block.get("text", "")) else "empty",
                        )
                    ] += 1

                for field, value in text_fields(block):
                    text_class = classify_text_field(
                        role, block_type, field, value, message_index
                    )
                    text_classes[text_class] += 1
                    placement, digit_width = tag_placement(value)
                    tag_placements[(text_class, placement)] += 1
                    if digit_width is not None:
                        prefix_shape = "§<digits>§ " if placement == "prefix_space" else "§<digits>§"
                        tag_prefix_formats[(text_class, prefix_shape, digit_width)] += 1
                    if (
                        text_class
                        in (
                            "assistant_text",
                            "user_text",
                            "user_transport_reminder",
                            "tool_result_text",
                        )
                        and placement != "prefix_space"
                        and not DROP_PATTERN.fullmatch(value)
                    ):
                        evidence_key = f"tag_scope_{text_class}_{placement}"
                        if len(special_evidence[evidence_key]) < 6:
                            special_evidence[evidence_key].append(
                                evidence(dump, message_index, block_index, value)
                            )

                    tag = TAG_PATTERN.match(value)
                    if tag:
                        tag_classes[(role, block_type, field)] += 1
                        if len(special_evidence["tag"]) < 6:
                            special_evidence["tag"].append(
                                evidence(dump, message_index, block_index, value)
                            )
                    temporal = TEMPORAL_PATTERN.match(value)
                    tag_temporal = TAG_TEMPORAL_PATTERN.match(value)
                    if text_class == "user_transport_reminder":
                        reminder_temporal_classes[
                            ("user_transport_reminder", "present" if temporal or tag_temporal else "absent")
                        ] += 1
                    if temporal or tag_temporal:
                        temporal_classes[(role, block_type, field)] += 1
                        if TEMPORAL_TAG_PATTERN.match(value):
                            temporal_tag_orders["temporal_then_tag"] += 1
                        elif TAG_TEMPORAL_PATTERN.match(value):
                            temporal_tag_orders["tag_then_temporal"] += 1
                        else:
                            temporal_tag_orders["temporal_without_leading_tag"] += 1
                        if TRANSPORT_TEMPORAL_PATTERN.match(value):
                            temporal_tag_orders["standalone_transport"] += 1
                        if len(special_evidence["temporal"]) < 12:
                            special_evidence["temporal"].append(
                                evidence(dump, message_index, block_index, value)
                            )
                    reminder_match = CHANNEL_REMINDER_PATTERN.search(value)
                    reminder = reminder_shape(value)
                    if reminder_match and reminder:
                        channel, band, version, hint_present, span = reminder
                        reminder_text = reminder_match.group("reminder")
                        body = reminder_match.group("body")
                        nudge_assembly_shapes[
                            (
                                channel,
                                band,
                                version,
                                role,
                                block_type,
                                types,
                                span,
                                "hint" if hint_present else "no_hint",
                            )
                        ] += 1
                        template = normalized_channel1_template(reminder_text)
                        channel1_reminder_shapes[
                            (
                                channel,
                                band,
                                version,
                                text_hash(reminder_text),
                                len(reminder_text),
                                short(reminder_text, 260),
                            )
                        ] += 1
                        channel1_template_shapes[
                            (channel, band, version, text_hash(template), template)
                        ] += 1
                        denominator = CHANNEL1_DENOMINATOR_PATTERN.search(body)
                        if denominator:
                            channel1_denominators[
                                (
                                    band,
                                    denominator.group("amount"),
                                    denominator.group("window"),
                                )
                            ] += 1
                        evidence_key = f"{channel}_{band}_{version}"
                        if len(special_evidence[evidence_key]) < 6:
                            special_evidence[evidence_key].append(
                                evidence(dump, message_index, block_index, reminder_text)
                            )
                    search_hint_drop = SEARCH_HINT_DROP_PATTERN.fullmatch(value)
                    if DROP_PATTERN.fullmatch(value) or search_hint_drop:
                        drop_shape = (
                            "tagged_dropped_with_search_hint"
                            if search_hint_drop
                            else "tagged_dropped"
                            if "§" in value
                            else "bare_dropped"
                        )
                        placeholder_values[drop_shape] += 1
                        drop_shapes[(text_class, drop_shape)] += 1
                        if len(special_evidence["drop"]) < 12:
                            special_evidence["drop"].append(
                                evidence(dump, message_index, block_index, value)
                            )
                    compaction = COMPACTION_MARKER_PATTERN.fullmatch(value)
                    if compaction:
                        placeholder_values["compaction_summary"] += 1
                        compaction_marker_shapes[
                            (
                                role,
                                block_type,
                                types,
                                block_index,
                                "tagged" if compaction.group("tag") else "untagged",
                                COMPACTION_MARKER_PATTERN.sub(
                                    "§<tag>§ [Compacted by magic-context — session history is managed by the plugin]",
                                    value,
                                ),
                            )
                        ] += 1
                        if len(special_evidence["compaction_marker"]) < 12:
                            special_evidence["compaction_marker"].append(
                                evidence(dump, message_index, block_index, value)
                            )
                    if "...[truncated]" in value:
                        placeholder_values["...[truncated]"] += 1
                    elif "truncated" in value.lower():
                        placeholder_values["other_truncated_text"] += 1

        for call_index, tool_id in enumerate(tool_call_order):
            name, input_shape, message_index, block_index = tool_calls[tool_id]
            result_shape = tool_result_shapes.get(tool_id, "missing")
            if input_shape == "full_or_small" and result_shape not in (
                "tagged_dropped",
                "bare_dropped",
            ):
                continue
            newer_tool_calls = len(tool_call_order) - call_index - 1
            tool_reduction_arc_shapes[(name, input_shape, result_shape)] += 1
            if input_shape in ("skeleton", "edit_marker"):
                recency_band = "newest_20" if newer_tool_calls < 20 else "older_replay"
                skeleton_recency[(recency_band, newer_tool_calls)] += 1
                if len(special_evidence["skeleton"]) < 12:
                    special_evidence["skeleton"].append(
                        evidence(
                            dump,
                            message_index,
                            block_index,
                            f"tool={name} representation={input_shape} newer_tool_calls={newer_tool_calls} result={result_shape}",
                        )
                    )

        anomalies["duplicate_tool_use_ids"] += sum(count - 1 for count in tool_ids.values() if count > 1)
        anomalies["orphan_tool_results"] += sum(
            count for tool_id, count in result_ids.items() if tool_ids[tool_id] == 0
        )
        anomalies["tool_uses_without_result"] += sum(
            count for tool_id, count in tool_ids.items() if result_ids[tool_id] == 0
        )

    todo_summary = {
        call_id: {
            "observations": len(rows),
            "positions": sorted({position for _, position, _ in rows}),
            "pair_hashes": sorted({digest for _, _, digest in rows}),
            "first_file": rows[0][0],
            "last_file": rows[-1][0],
        }
        for call_id, rows in sorted(todo_observations.items())
    }
    return {
        "dump_count": len(dumps),
        "sessions": dict(sorted(sessions.items())),
        "project_roots": counter_dict(project_roots),
        "response_statuses": counter_dict(response_statuses),
        "response_usage_bands": counter_dict(response_usage_bands),
        "max_response_usage": max_response_usage,
        "system_shapes": counter_dict(system_shapes),
        "system_compositions": counter_dict(system_compositions),
        "guidance_suffixes": counter_dict(guidance_suffixes),
        "head_shapes_top40": counter_dict(head_shapes, 40),
        "m0_section_orders": counter_dict(m0_section_orders),
        "m0_section_separators": counter_dict(m0_section_separators),
        "m1_section_orders": counter_dict(m1_section_orders),
        "m1_section_separators": counter_dict(m1_section_separators),
        "compartment_heading_shapes": counter_dict(compartment_heading_shapes),
        "assistant_part_orders_top40": counter_dict(assistant_orders, 40),
        "trailing_shapes_top40": counter_dict(trailing_shapes, 40),
        "text_classes": counter_dict(text_classes),
        "tag_classes": counter_dict(tag_classes),
        "tag_placements": counter_dict(tag_placements),
        "tag_prefix_formats": counter_dict(tag_prefix_formats),
        "temporal_classes": counter_dict(temporal_classes),
        "temporal_tag_orders": counter_dict(temporal_tag_orders),
        "reminder_temporal_classes": counter_dict(reminder_temporal_classes),
        "channel1_reminder_shapes": counter_dict(channel1_reminder_shapes),
        "channel1_template_shapes": counter_dict(channel1_template_shapes),
        "channel1_denominators": counter_dict(channel1_denominators),
        "nudge_assembly_shapes": counter_dict(nudge_assembly_shapes),
        "m1_placeholders": counter_dict(m1_placeholders),
        "tool_input_shapes_top40": counter_dict(tool_input_shapes, 40),
        "reduced_envelopes": counter_dict(reduced_envelopes),
        "tool_special_values_top40": counter_dict(tool_special_values, 40),
        "tool_reduction_arc_shapes_top40": counter_dict(tool_reduction_arc_shapes, 40),
        "tool_reduction_vocabulary_top100": counter_dict(tool_reduction_vocabulary, 100),
        "skeleton_recency_top40": counter_dict(skeleton_recency, 40),
        "placeholder_values": counter_dict(placeholder_values),
        "drop_shapes": counter_dict(drop_shapes),
        "compaction_marker_shapes": counter_dict(compaction_marker_shapes),
        "media_shapes": counter_dict(media_shapes),
        "thinking_shapes": counter_dict(thinking_shapes),
        "reasoning_order_shapes_top40": counter_dict(reasoning_order_shapes, 40),
        "newest_assistant_reasoning_presence": counter_dict(
            newest_assistant_reasoning_presence
        ),
        "newest_assistant_reasoning_shapes_top40": counter_dict(
            newest_assistant_reasoning_shapes, 40
        ),
        "cache_placements": counter_dict(cache_placements),
        "block_key_shapes_top40": counter_dict(message_block_key_shapes, 40),
        "synthetic_todo": todo_summary,
        "anomalies": counter_dict(anomalies),
        "evidence": dict(special_evidence),
    }


def compare_ts_pi_axes(ts: dict[str, Any], pi: dict[str, Any]) -> dict[str, Any]:
    def key_space(summary: dict[str, Any], fields: tuple[str, ...]) -> set[str]:
        return {
            f"{field}:{key}"
            for field in fields
            for key in summary.get(field, {})
        }

    def compare(
        name: str,
        fields: tuple[str, ...],
        ledger: str | None,
        expectation: str = "same_effective_shape",
    ) -> dict[str, Any]:
        ts_keys = key_space(ts, fields)
        pi_keys = key_space(pi, fields)
        if not ts_keys or not pi_keys:
            verdict = "evidence_gap"
        elif ts_keys == pi_keys:
            verdict = "matched_shape_space"
        else:
            verdict = "divergent_shape_space"
        return {
            "axis": name,
            "verdict": verdict,
            "expectation": expectation,
            "intentional_divergence_ledger": ledger,
            "opencode_only": sorted(ts_keys - pi_keys),
            "pi_only": sorted(pi_keys - ts_keys),
            "shared": sorted(ts_keys & pi_keys),
        }

    axes = [
        compare(
            "tagging_and_fallback_adoption",
            ("tag_placements", "tag_prefix_formats"),
            None,
        ),
        compare(
            "m0_m1_render",
            (
                "m0_section_orders",
                "m0_section_separators",
                "m1_section_orders",
                "m1_section_separators",
                "m1_placeholders",
            ),
            "PARITY.md §9 (date attributes) and §26 (mural envelope) are the only allowed envelope differences",
        ),
        compare(
            "rendered_compaction_marker",
            ("compaction_marker_shapes",),
            "PARITY.md §4 allows marker-drain mechanism differences, not rendered marker bytes",
        ),
        compare(
            "nudge_template",
            ("channel1_template_shapes",),
            "PARITY.md §9 requires shared copy and metrics",
        ),
        compare(
            "nudge_carrier",
            ("nudge_assembly_shapes",),
            "PARITY.md §9 allows tool-output and hidden-delivery carrier differences",
            "intentional_carrier_difference",
        ),
        compare(
            "caveman_and_strip",
            (
                "tool_reduction_arc_shapes_top40",
                "tool_reduction_vocabulary_top100",
                "drop_shapes",
            ),
            "PARITY.md §2 allows Pi splice versus OpenCode sentinel only after equivalent content removal",
        ),
    ]
    unexplained = [
        row
        for row in axes
        if row["verdict"] == "divergent_shape_space"
        and row["expectation"] == "same_effective_shape"
    ]
    return {
        "axes": axes,
        "unexplained_byte_classes": unexplained,
        "ledger_baseline": "packages/pi-plugin/PARITY.md",
        "note": "counts are never compared; each axis compares observed shape key spaces and retains lane-only evidence for adjudication",
    }


def tool_result_text(block: dict[str, Any]) -> str | None:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        values = [
            item.get("text")
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ]
        return "\n".join(values) if values else None
    return None


def normalize_facade_output(value: str) -> str:
    normalized = TAG_PATTERN.sub("", value, count=1)
    return TEMPORAL_PATTERN.sub("", normalized, count=1)


def facade_output_shape(value: str) -> str:
    if DROP_PATTERN.fullmatch(value) or SEARCH_HINT_DROP_PATTERN.fullmatch(value):
        return "dropped"
    first = value.splitlines()[0] if value else "empty"
    if first.startswith("Messages ") and "(verbose)" in first:
        return "expand_verbose"
    if first.startswith("Messages "):
        return "expand_range"
    if "full recovery:" in first:
        return "expand_full"
    if first.startswith("No message") or "no longer recoverable" in first:
        return "expand_missing"
    if first.startswith("Error:"):
        return "error"
    if value.startswith("["):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return "json_array"
        except json.JSONDecodeError:
            pass
    return first[:80]


def compare_ctx_facades(dumps: list[Dump]) -> dict[str, Any]:
    observations: dict[
        tuple[str, str], dict[str, dict[tuple[str, str], dict[str, Any]]]
    ] = collections.defaultdict(lambda: collections.defaultdict(dict))
    for dump in dumps:
        if dump.lane not in ("rust", "ts"):
            continue
        messages = dump.body.get("messages")
        if not isinstance(messages, list):
            continue
        calls: dict[str, tuple[str, str]] = {}
        for message_index, message in enumerate(messages):
            if not isinstance(message, dict):
                continue
            for block_index, block in enumerate(blocks(message)):
                if block.get("type") == "tool_use":
                    call_id = block.get("id")
                    name = block.get("name")
                    tool_input = block.get("input")
                    if (
                        isinstance(call_id, str)
                        and isinstance(name, str)
                        and name in CTX_FACADE_NAMES
                        and isinstance(tool_input, dict)
                    ):
                        calls[call_id] = (name, raw_hash(tool_input))
                    continue
                if block.get("type") != "tool_result":
                    continue
                call_id = block.get("tool_use_id")
                if not isinstance(call_id, str) or call_id not in calls:
                    continue
                output = tool_result_text(block)
                if output is None:
                    continue
                normalized = normalize_facade_output(output)
                name, input_hash = calls[call_id]
                identity = (dump.session, call_id)
                observations[(name, input_hash)][dump.lane].setdefault(
                    identity,
                    {
                        "output_sha256": text_hash(normalized),
                        "output_bytes": len(normalized.encode()),
                        "shape": facade_output_shape(normalized),
                        "evidence": evidence(
                            dump, message_index, block_index, short(normalized, 240)
                        ),
                    },
                )
    matched: list[dict[str, Any]] = []
    only: dict[str, list[dict[str, Any]]] = {"rust": [], "ts": []}
    divergences: list[dict[str, Any]] = []
    for (name, input_hash), lanes in sorted(observations.items()):
        lane_outputs = {
            lane: sorted(
                {
                    (row["output_sha256"], row["output_bytes"], row["shape"])
                    for row in lane_rows.values()
                }
            )
            for lane, lane_rows in lanes.items()
        }
        row = {
            "tool": name,
            "input_sha256": input_hash,
            "outputs": lane_outputs,
            "evidence": {
                lane: next(iter(lane_rows.values()))["evidence"]
                for lane, lane_rows in lanes.items()
                if lane_rows
            },
        }
        if "rust" in lanes and "ts" in lanes:
            row["verdict"] = "byte_equal" if lane_outputs["rust"] == lane_outputs["ts"] else "divergent"
            matched.append(row)
            if row["verdict"] == "divergent":
                divergences.append(row)
        else:
            lane = next(iter(lanes))
            only[lane].append(row)
    return {
        "matched_input_classes": matched,
        "lane_only_input_classes": only,
        "unexplained_byte_classes": divergences,
        "note": "leading transform tags and temporal carriers are removed before output hashing",
    }


LIVE_PROVIDER_FAMILIES = (
    "anthropic:anthropic",
    "bedrock:anthropic",
    "github-copilot:openai_compatible",
    "qwen:openai_compatible",
    "openai:openai_compatible",
    "openai:openai_responses",
    "google:gemini",
    "moonshot:openai_compatible",
)


def live_dump_directories(explicit: Path | None) -> list[Path]:
    roots: set[Path] = set()
    if explicit is not None:
        roots.add(explicit)
        parent = explicit.parent
    else:
        parent = Path(tempfile.gettempdir())
    roots.update(path for path in parent.glob("opencode-*-auth-dumps") if path.is_dir())
    return sorted(roots)


def live_provider_report(dumps: list[Dump]) -> dict[str, Any]:
    matrix = compare_provider_matrix(dumps)
    matrix.pop("evidence", None)
    evidence_rows = [summarize_provider_dump(dump) for dump in dumps]
    sanitized_evidence: list[dict[str, Any]] = []
    for row in evidence_rows:
        dump = next(
            (
                candidate
                for candidate in dumps
                if candidate.path.name == row["file"] and candidate.session == row["session"]
            ),
            None,
        )
        if dump is None:
            continue
        raw = dump.path.read_bytes()
        sanitized_evidence.append(
            {
                "capture_sha256": hashlib.sha256(raw).hexdigest(),
                "capture_bytes": len(raw),
                "session_prefix": dump.session[:8],
                "lane": row["lane"],
                "provider_family": row["provider_family"],
                "message_count": row["message_count"],
                "system_message_count": row["system_message_count"],
                "system_block_count": row["system_block_count"],
                "empty_content_shapes": row["empty_content_shapes"],
                "dropped_placeholder_shapes": row["dropped_placeholder_shapes"],
                "tool_pairing_shapes": row["tool_pairing_shapes"],
                "reasoning_signature_shapes": row["reasoning_signature_shapes"],
                "unexplained_invariants": row["unexplained_invariants"],
                "adjacency_violations": [
                    {
                        "message_ordinal": violation.get("message_index"),
                        "missing_results": len(violation.get("missing_result_ids", [])),
                        "unexpected_results": len(
                            violation.get("unexpected_result_ids", [])
                        ),
                        "orphan_results": len(violation.get("orphan_result_ids", [])),
                    }
                    for violation in row["adjacency_violations"]
                ],
            }
        )
    counts = collections.Counter(row["provider_family"] for row in sanitized_evidence)
    matrix["inventory_by_lane"] = {
        lane: counter_dict(
            collections.Counter(
                row["provider_family"]
                for row in sanitized_evidence
                if row["lane"] == lane
            )
        )
        for lane in ("rust", "ts", "unverified")
    }
    matrix["unexplained_wire_invariants"] = [
        {
            "capture_sha256": row["capture_sha256"],
            "capture_bytes": row["capture_bytes"],
            "session_prefix": row["session_prefix"],
            "lane": row["lane"],
            "provider_family": row["provider_family"],
            "classes": row["unexplained_invariants"],
            "adjacency_violations": row["adjacency_violations"],
        }
        for row in sanitized_evidence
        if row["unexplained_invariants"]
    ]
    matrix["live_family_counts"] = {
        family: counts.get(family, 0) for family in LIVE_PROVIDER_FAMILIES
    }
    matrix["zero_live_coverage_families"] = [
        family for family in LIVE_PROVIDER_FAMILIES if counts.get(family, 0) == 0
    ]
    matrix["non_anthropic_capture_count"] = sum(
        count for family, count in counts.items() if family != "anthropic:anthropic"
    )
    matrix["non_anthropic_unverified_lane_count"] = sum(
        1
        for row in sanitized_evidence
        if row["provider_family"] != "anthropic:anthropic"
        and row["lane"] == "unverified"
    )
    matrix["evidence"] = sanitized_evidence
    return matrix


def invoke_live_probe(
    args: argparse.Namespace, after_ms: int, engine_after_ms: int
) -> dict[str, Any]:
    home = Path.home()
    storage_dir = os.environ.get("MAGIC_CONTEXT_STORAGE_DIR", "").strip()
    storage_root = Path(storage_dir) if storage_dir else home / ".local/share/cortexkit/magic-context"
    context_db = args.context_db or storage_root / "context.db"
    store_db = args.store_db or storage_root / "store.db"
    store_root = args.store_root or storage_root
    opencode_db = args.opencode_db or home / ".local/share/opencode/opencode.db"
    pi_session_dir = args.pi_session_dir or home / ".pi/agent/sessions"
    rpc_root = args.rpc_root or storage_root / "rpc"
    command = [
        "bun",
        str(Path(__file__).with_name("audit-transform-wire-parity-live.ts")),
        "--context-db",
        str(context_db),
        "--store-db",
        str(store_db),
        "--store-root",
        str(store_root),
        "--opencode-db",
        str(opencode_db),
        "--pi-session-dir",
        str(pi_session_dir),
        "--rpc-root",
        str(rpc_root),
        "--after-ms",
        str(after_ms),
        "--engine-after-ms",
        str(engine_after_ms),
    ]
    if args.skip_live_rpc:
        command.append("--skip-rpc")
    if args.skip_live_rust_oracle:
        command.append("--skip-rust-oracle")
    completed = subprocess.run(
        command,
        cwd=Path(__file__).resolve().parent.parent,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return {
            "status": "failed",
            "exit_code": completed.returncode,
            "stderr_sha256": hashlib.sha256(completed.stderr.encode()).hexdigest(),
            "stderr_bytes": len(completed.stderr.encode()),
        }
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "status": "failed",
            "exit_code": completed.returncode,
            "stdout_sha256": hashlib.sha256(completed.stdout.encode()).hexdigest(),
            "stdout_bytes": len(completed.stdout.encode()),
        }


def live_ledger_report(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"present": False, "rows": 0, "parse_error_count": 0}
    summary = summarize_window_report_ledger(path)
    return {
        "present": summary.get("status") == "ok",
        "rows": summary.get("rows", 0),
        "key_shape_count": len(summary.get("key_shapes", {})),
        "geometry_count": sum(summary.get("geometries", {}).values()),
        "status_count": sum(summary.get("statuses", {}).values()),
        "parse_error_count": len(summary.get("parse_errors", [])),
    }


def live_leg_verdicts(provider: dict[str, Any], probe: dict[str, Any]) -> list[dict[str, Any]]:
    if probe.get("status") == "failed":
        return [
            {
                "leg": leg,
                "origin_hunt": origin,
                "verdict": "FINDING",
                "classes": ["live_probe_failed"],
            }
            for leg, origin in (
                (1, 6),
                (2, 8),
                (3, 8),
                (4, 5),
                (5, 7),
                (6, "1-4"),
            )
        ]

    engine = probe.get("engine_truth", {})
    engine_classes = [
        row.get("class") for row in engine.get("unexplained_invariants", [])
    ]
    engine_sessions = engine.get("sessions", [])
    if not any(
        row.get("compartments", {}).get("mirror_since_cutoff", 0) > 0
        for row in engine_sessions
    ):
        engine_classes.append("zero_post_cutoff_rust_compartment_publish_rows")
    if not any(
        row.get("memories", {}).get("mirror_since_cutoff", 0) > 0
        for row in engine_sessions
    ):
        engine_classes.append("zero_post_cutoff_rust_memory_publish_rows")

    caveman = probe.get("caveman", {})
    caveman_classes = [
        row.get("class") for row in caveman.get("unexplained_invariants", [])
    ]
    if {row.get("lane") for row in caveman.get("sessions", [])} != {"rust", "ts"}:
        caveman_classes.append("missing_live_aged_lane")
    if caveman.get("rust_oracle_status") != "ok":
        caveman_classes.append("rust_live_oracle_not_ok")

    provider_classes = [
        "provider_value_space_divergence"
        for _ in provider.get("unexplained_byte_classes", [])
    ] + [
        class_name
        for row in provider.get("unexplained_wire_invariants", [])
        for class_name in row.get("classes", [])
    ]
    if provider.get("non_anthropic_unverified_lane_count", 0) > 0:
        provider_classes.append("non_anthropic_lane_unverified")

    pi = probe.get("pi_real_jsonl", {})
    pi_classes = [row.get("class") for row in pi.get("unexplained_invariants", [])]
    if pi.get("coverage", {}).get("observed_sessions", 0) < 2:
        pi_classes.append("fewer_than_two_real_pi_sessions")
    for row in pi.get("sessions", []):
        if not row.get("m0", {}).get("present") or not row.get("m1", {}).get("present"):
            pi_classes.append("pi_cached_m0_or_m1_absent")

    operator = probe.get("operator_reads", {})
    operator_classes = [
        str(row.get("class", row.get("field")))
        for row in operator.get("unexplained_invariants", [])
    ]
    if operator.get("coverage", {}).get("observed_lanes", 0) < 2:
        operator_classes.append("missing_live_operator_lane")

    decisions = probe.get("decision_window", {})
    decision_classes = [
        str(row.get("class")) for row in decisions.get("unexplained_invariants", [])
    ]
    distributions = decisions.get("transform_decisions", {})
    for lane in ("rust", "ts"):
        if distributions.get(lane, {}).get("rows", 0) == 0:
            decision_classes.append(f"zero_{lane}_transform_decision_rows")
    if decisions.get("scheduler_history", {}).get("rows", 0) == 0:
        decision_classes.append("zero_scheduler_history_rows")

    return [
        {
            "leg": leg,
            "origin_hunt": origin,
            "verdict": "CLOSED" if not classes else "FINDING",
            "classes": sorted(set(filter(None, classes))),
        }
        for leg, origin, classes in (
            (1, 6, engine_classes),
            (2, 8, caveman_classes),
            (3, 8, provider_classes),
            (4, 5, pi_classes),
            (5, 7, operator_classes),
            (6, "1-4", decision_classes),
        )
    ]


def run_live(args: argparse.Namespace) -> None:
    expected_rust_sessions = set(args.rust_sessions or RUST_SESSIONS)
    paths: list[Path] = []
    directories = live_dump_directories(args.dump_dir)
    for directory in directories:
        paths.extend(
            choose_paths(directory, args.date, args.per_session, args.after, args.before)
        )
    dumps = load_dumps(paths, expected_rust_sessions)
    try:
        config_overrides = project_config_overrides(args.project_config)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    dumps, _lane_verification = verify_dump_lanes(
        dumps, expected_rust_sessions, config_overrides
    )
    provider = live_provider_report(dumps)
    after_ms = parse_bound(args.after, args.date)
    engine_after_ms = parse_bound(args.engine_after or args.after, args.date)
    probe = invoke_live_probe(args, after_ms, engine_after_ms)
    report = {
        "method": {
            "mode": "live",
            "date": args.date,
            "after": args.after,
            "before": args.before,
            "engine_after": args.engine_after,
            "per_session": args.per_session,
            "capture_directories": len(directories),
            "capture_files": len(dumps),
            "expected_rust_session_prefixes": sorted(
                session[:8] for session in expected_rust_sessions
            ),
            "privacy_contract": "hashes, counts, ordinals, eight-character session prefixes, and byte lengths only",
            "sqlite_contract": {"readonly": True},
        },
        "provider_live": provider,
        "window_report_ledger_live": live_ledger_report(args.window_report_ledger),
        "live_probe": probe,
        "leg_verdicts": live_leg_verdicts(provider, probe),
    }
    print(json.dumps(report, ensure_ascii=False, indent=args.indent, sort_keys=True))


def main() -> None:
    args = parse_args()
    if args.live:
        run_live(args)
        return
    if args.dump_dir is None:
        raise SystemExit("dump_dir is required unless --live is used")
    expected_rust_sessions = set(args.rust_sessions or RUST_SESSIONS)
    try:
        config_overrides = project_config_overrides(args.project_config)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    dumps = load_dumps(
        choose_paths(args.dump_dir, args.date, args.per_session, args.after, args.before),
        expected_rust_sessions,
    )
    dumps, lane_verification = verify_dump_lanes(
        dumps, expected_rust_sessions, config_overrides
    )
    sessions = {dump.session for dump in dumps}
    start_ms = parse_bound(args.after, args.date)
    end_ms = parse_bound(args.before, args.date, end=True)
    dumps = apply_observed_lanes(
        dumps,
        lane_verification,
        observed_authority_lanes(
            args.context_db, args.store_db, sessions, start_ms, end_ms
        ),
    )
    lane_by_session: dict[str, str] = {}
    for session in sessions:
        observed = {dump.lane for dump in dumps if dump.session == session}
        lane_by_session[session] = next(iter(observed)) if len(observed) == 1 else "unverified"

    pi_dumps = (
        load_pi_render_dumps(
            choose_pi_render_paths(args.pi_render_dir, args.date, args.per_session)
        )
        if args.pi_render_dir is not None
        else []
    )
    pi_dumps, pi_lane_verification = verify_pi_render_configs(pi_dumps, config_overrides)
    dumps.extend(pi_dumps)
    lane_summaries = {
        lane: summarize_lane([dump for dump in dumps if dump.lane == lane])
        for lane in ("rust", "ts", "pi")
    }
    report = {
        "method": {
            "date": args.date,
            "per_session": args.per_session,
            "after": args.after,
            "before": args.before,
            "expected_rust_sessions": sorted(expected_rust_sessions),
            "project_config_overrides": {
                root: str(path) for root, path in sorted(config_overrides.items())
            },
            "context_db": str(args.context_db) if args.context_db else None,
            "store_db": str(args.store_db) if args.store_db else None,
            "pi_session_dir": str(args.pi_session_dir) if args.pi_session_dir else None,
            "pi_render_dir": str(args.pi_render_dir) if args.pi_render_dir else None,
            "omp_session_dir": str(args.omp_session_dir) if args.omp_session_dir else None,
            "window_report_ledger": (
                str(args.window_report_ledger) if args.window_report_ledger else None
            ),
        },
        "lane_verification": lane_verification,
        "pi_lane_verification": pi_lane_verification,
        "lanes": lane_summaries,
        "pi_session_sources": summarize_pi_session_sources(args.pi_session_dir),
        "omp_session_sources": summarize_omp_session_sources(args.omp_session_dir),
        "overflow_report_ledger": summarize_window_report_ledger(
            args.window_report_ledger
        ),
        "ts_pi_cross_harness_parity": compare_ts_pi_axes(
            lane_summaries["ts"], lane_summaries["pi"]
        ),
        "provider_matrix_parity": compare_provider_matrix(dumps),
        "excluded_unverified_dumps": [
            dump.path.name for dump in dumps if dump.lane == "unverified"
        ],
        "ctx_facade_parity": compare_ctx_facades(dumps),
    }
    if args.context_db is not None or args.store_db is not None:
        report["engine_adjacent_state"] = summarize_engine_adjacent_state(
            args.context_db,
            args.store_db,
            sessions,
            lane_by_session,
        )
        report["operator_read_state"] = summarize_operator_read_state(
            args.context_db,
            args.store_db,
            sessions,
            lane_by_session,
        )
        report["telemetry"] = summarize_telemetry(
            args.context_db,
            args.store_db,
            sessions,
            lane_by_session,
            start_ms,
            end_ms,
        )
    print(json.dumps(report, ensure_ascii=False, indent=args.indent, sort_keys=True))


if __name__ == "__main__":
    main()
