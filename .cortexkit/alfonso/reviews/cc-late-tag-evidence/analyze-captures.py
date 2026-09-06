"""Summarize the local captures without copying request headers or full conversations."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).parent
captures = root / "captures"
manifest = json.loads((captures / "manifest.json").read_text())
for entry in manifest:
    actual = hashlib.sha256((captures / entry["file"]).read_bytes()).hexdigest()
    assert actual == entry["sha256"], entry["file"]

def serialized(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()

before, after = [json.loads((captures / f"{number}-fwd-body").read_text()) for number in (12989, 12990)]
summary = {"capture_hashes_verified": len(manifest), "exchanges": {}}
for number, body, request_name, response_name in [
    (12989, before, "0a1a49682f157a5c.request.json", "1788702363272-0a1a49682f157a5c.response.json"),
    (12990, after, "a348f0d1ff95c0d3.request.json", "1788702367779-a348f0d1ff95c0d3.response.json"),
]:
    request = json.loads((captures / request_name).read_text())
    response = json.loads((captures / response_name).read_text())
    summary["exchanges"][str(number)] = {
        "message_count": len(body["messages"]),
        "last_assistant_index": max(i for i, message in enumerate(body["messages"]) if message["role"] == "assistant"),
        "last_reasoning_first_mid": next(message["mid"] for message in reversed(request["messages"]) if message["ck"]["role"] == "assistant" and message["ck"]["content"][0]["kind"]["type"] in ("reasoning", "redacted_reasoning")),
        "tail_shapes": [{"index": i, "role": message["role"], "blocks": [block["type"] for block in message["content"]]} for i, message in enumerate(body["messages"]) if i >= 52],
        "mid_turn": request["mid_turn"],
        "model_key": request["model_key"],
        "action": response["action"],
        "scheduler_decision": response["scheduler_decision"],
        "scheduler_defer_reason": response["scheduler_defer_reason"],
        "first_divergence": response.get("first_divergence"),
    }
old, new = before["messages"][52], after["messages"][52]
summary["first_differing_message"] = next(i for i, (left, right) in enumerate(zip(before["messages"], after["messages"])) if serialized(left) != serialized(right))
summary["message_52"] = {
    "old_text": old["content"][1]["text"],
    "new_text": new["content"][1]["text"],
    "thinking_identical": serialized(old["content"][0]) == serialized(new["content"][0]),
    "tool_use_identical": serialized(old["content"][2]) == serialized(new["content"][2]),
    "prefix_only_text_change": new["content"][1]["text"] == "§186§ " + old["content"][1]["text"],
}
summary["m0_m1_identical"] = serialized(before["messages"][:2]) == serialized(after["messages"][:2])
(root / "capture-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(summary, ensure_ascii=False, indent=2))
