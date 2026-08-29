#!/usr/bin/env python3
"""Hermetic machinery-audit smoke test with served bytes and durable rows."""

from __future__ import annotations

import datetime as dt
import json
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "audit-transform-wire-parity.py"
DATE = "2026-08-27"


class AuditTransformWireParityTest(unittest.TestCase):
    def test_historian_producer_contract_is_exact_and_non_vacuous(self) -> None:
        module = runpy.run_path(str(SCRIPT))
        contract = module["summarize_historian_producer_contract"](ROOT)
        self.assertEqual(contract["unexplained_invariants"], [])
        self.assertEqual(
            contract["calibration"]["ts"],
            {
                "temperature": 0.1,
                "max_output_tokens": 32_000,
                "await_timeout_ms": 600_000,
            },
        )
        self.assertEqual(contract["request_shape"]["pi"], ["system", "user"])
        self.assertEqual(contract["request_shape"]["rust"], ["system", "user"])
        self.assertEqual(contract["reference_selection"]["ts"]["rotating_seed_floor"], 4)
        self.assertEqual(contract["reference_selection"]["rust"]["session_recency_window"], 6)

        mural = module["summarize_mural_compose_contract"](ROOT)
        self.assertEqual(mural["unexplained_invariants"], [])
        self.assertEqual(mural["ts"]["sha256"], mural["rust"]["sha256"])
        self.assertEqual(
            module["summarize_wrapup_contract"](ROOT)["unexplained_invariants"], []
        )
        hunt12 = module["summarize_hunt12_source_contract"](ROOT)
        self.assertEqual(hunt12["unexplained_invariants"], [])
        self.assertTrue(hunt12["cache_seams"]["delta_resumes_after_bust_adoption"])
        self.assertTrue(hunt12["language_directives"]["rust_classifier_localized"])
        self.assertTrue(hunt12["mapping_origin"]["cross_lane_regressions_present"])
        self.assertTrue(hunt12["provider_lane_coordinates"]["readonly_binding_projection"])
        broken_hunt12 = json.loads(json.dumps(hunt12))
        broken_hunt12["mapping_origin"]["module_payload_preserves_origin"] = False
        self.assertEqual(
            module["hunt12_source_invariants"](broken_hunt12),
            ["hunt12_mapping_origin_module_payload_preserves_origin_missing"],
        )

        broken = json.loads(json.dumps(contract))
        broken["calibration"]["ts"]["temperature"] = 1.0
        self.assertEqual(
            module["historian_producer_invariants"](broken),
            ["historian_ts_calibration_triple_diverges"],
        )

    def test_live_leg_5_preserves_the_specific_tag_total_failure_class(self) -> None:
        module = runpy.run_path(str(SCRIPT))
        verdicts = module["live_leg_verdicts"](
            {},
            {
                "operator_reads": {
                    "coverage": {"observed_lanes": 2},
                    "unexplained_invariants": [
                        {
                            "class": "rust_status_tag_total_mismatch",
                            "field": "totalTags",
                        }
                    ],
                }
            },
        )
        leg_5 = next(row for row in verdicts if row["leg"] == 5)

        self.assertEqual(leg_5["verdict"], "FINDING")
        self.assertEqual(leg_5["classes"], ["rust_status_tag_total_mismatch"])

    def test_config_verified_lanes_facades_and_historian_rows(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            temp = Path(temporary)
            dump_dir = temp / "dumps"
            dump_dir.mkdir()
            rust_root = temp / "rust-project"
            ts_root = temp / "ts-project"
            for project in (rust_root, ts_root):
                (project / ".cortexkit").mkdir(parents=True)
            (rust_root / ".cortexkit" / "magic-context.jsonc").write_text(
                '{\n  // Live lane authority.\n  "transform_mode": "rust",\n}\n'
            )
            (ts_root / ".cortexkit" / "magic-context.jsonc").write_text(
                "{ // Empty means the TypeScript default.\n}\n"
            )
            providers = (
                "anthropic",
                "github-copilot",
                "bedrock",
                "qwen",
                "openai",
                "google",
                "moonshot",
            )
            for minute, provider in enumerate(providers):
                self._write_dump(
                    dump_dir,
                    "ses_rust",
                    rust_root,
                    f"rust-{provider}-call",
                    provider,
                    minute,
                )
                self._write_dump(
                    dump_dir,
                    "ses_ts",
                    ts_root,
                    f"ts-{provider}-call",
                    provider,
                    minute,
                )
            pi_session_dir = temp / "pi-sessions"
            pi_render_dir = temp / "pi-renders"
            omp_session_dir = temp / "omp-sessions"
            pi_session_dir.mkdir()
            pi_render_dir.mkdir()
            omp_session_dir.mkdir()
            self._write_pi_session(pi_session_dir)
            self._write_pi_session(omp_session_dir)
            self._write_pi_render(pi_render_dir, ts_root)
            window_report_ledger = temp / "window-reports.jsonl"
            window_report_ledger.write_text(
                json.dumps(
                    {
                        "provider_id": "anthropic",
                        "model_id": "claude",
                        "access_path": "api",
                        "status": 400,
                        "geometry": "combined",
                        "observed_at_ms": 1,
                    }
                )
                + "\n"
            )

            context_db = temp / "context.db"
            store_db = temp / "store.db"
            self._write_context_db(context_db)
            self._write_store_db(store_db)

            completed = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    str(dump_dir),
                    "--date",
                    DATE,
                    "--per-session",
                    "10",
                    "--context-db",
                    str(context_db),
                    "--store-db",
                    str(store_db),
                    "--pi-session-dir",
                    str(pi_session_dir),
                    "--pi-render-dir",
                    str(pi_render_dir),
                    "--omp-session-dir",
                    str(omp_session_dir),
                    "--window-report-ledger",
                    str(window_report_ledger),
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(completed.stdout)
            self.assertEqual(
                report["lane_verification"]["denominator_dump_counts"],
                {"rust": 7, "ts": 7},
            )
            rows = report["lane_verification"]["sessions"]
            rust = next(row for row in rows if row["session"] == "ses_rust")
            ts = next(row for row in rows if row["session"] == "ses_ts")
            self.assertEqual(rust["configured_lane"], "rust")
            self.assertEqual(rust["status"], "label_corrected_from_live_config")
            self.assertEqual(ts["configured_lane"], "ts")
            self.assertEqual(report["excluded_unverified_dumps"], [])
            mural = report["mural_compose_contract"]
            self.assertEqual(mural["unexplained_invariants"], [])
            self.assertEqual(mural["ts"]["sha256"], mural["rust"]["sha256"])
            self.assertEqual(report["wrapup_contract"]["unexplained_invariants"], [])
            self.assertEqual(report["unexplained_bucket"]["count"], 0)

            producer = report["historian_producer_contract"]
            self.assertEqual(producer["unexplained_invariants"], [])
            self.assertEqual(producer["request_shape"]["ts"], ["system", "user"])
            self.assertEqual(producer["request_shape"]["pi"], ["system", "user"])
            self.assertEqual(producer["request_shape"]["rust"], ["system", "user"])
            self.assertEqual(
                producer["system_prompt"]["ts_sha256"],
                producer["system_prompt"]["rust_sha256"],
            )

            provider_matrix = report["provider_matrix_parity"]
            self.assertEqual(provider_matrix["unexplained_byte_classes"], [])
            self.assertEqual(provider_matrix["unexplained_wire_invariants"], [])
            self.assertEqual(
                set(provider_matrix["inventory_by_lane"]["rust"]),
                {
                    "anthropic:anthropic",
                    "bedrock:anthropic",
                    "github-copilot:openai_compatible",
                    "google:gemini",
                    "moonshot:openai_compatible",
                    "openai:openai_compatible",
                    "qwen:openai_compatible",
                },
            )
            self.assertTrue(
                all(
                    axis["verdict"] == "matched_value_space"
                    for axis in provider_matrix["axes"]
                )
            )
            self.assertEqual(
                report["pi_lane_verification"]["denominator_dump_counts"], {"pi": 1}
            )
            self.assertEqual(report["lanes"]["pi"]["dump_count"], 1)
            self.assertEqual(report["pi_session_sources"]["totals"]["files"], 1)
            self.assertEqual(
                report["pi_session_sources"]["totals"]["missing_entry_ids"], 0
            )
            self.assertEqual(report["omp_session_sources"]["totals"]["files"], 1)
            self.assertEqual(report["overflow_report_ledger"]["rows"], 1)
            self.assertEqual(report["overflow_report_ledger"]["parse_errors"], [])
            tagging = next(
                axis
                for axis in report["ts_pi_cross_harness_parity"]["axes"]
                if axis["axis"] == "tagging_and_fallback_adoption"
            )
            self.assertEqual(tagging["verdict"], "matched_shape_space")
            self.assertEqual(
                report["ts_pi_cross_harness_parity"]["unexplained_byte_classes"], []
            )

            facades = report["ctx_facade_parity"]
            self.assertEqual(len(facades["matched_input_classes"]), 1)
            self.assertEqual(facades["matched_input_classes"][0]["verdict"], "byte_equal")
            self.assertEqual(facades["unexplained_byte_classes"], [])

            telemetry = report["telemetry"]
            rust_rows = telemetry["rust_historian_rows"]
            ts_rows = telemetry["ts_historian_rows"]
            self.assertEqual(rust_rows["compartments"]["rows_born_in_window"], 1)
            self.assertEqual(rust_rows["compartments"]["complete_date_rows"], 1)
            self.assertEqual(ts_rows["compartments"]["rows_born_in_window"], 1)
            self.assertIsNone(ts_rows["compartments"]["complete_date_rows"])
            self.assertEqual(rust_rows["promoted_facts"]["rows_promoted_in_window"], 1)
            self.assertEqual(ts_rows["promoted_facts"]["rows_promoted_in_window"], 1)
            self.assertIn("mc_historian_side_channel_outbox", rust_rows["session_id_tables"])
            self.assertIn("compartment_events", ts_rows["session_id_tables"])

            adjacent = report["engine_adjacent_state"]
            self.assertEqual(adjacent["unexplained_invariants"], [])
            self.assertTrue(
                adjacent["coverage_by_lane"]["rust"][0]["message_index_present"]
            )
            self.assertTrue(
                adjacent["coverage_by_lane"]["ts"][0]["message_index_present"]
            )
            self.assertTrue(
                adjacent["coverage_by_lane"]["rust"][0]["chunk_vectors_present"]
            )
            self.assertTrue(
                adjacent["coverage_by_lane"]["ts"][0]["memory_vectors_present"]
            )
            self.assertEqual(
                adjacent["per_session"]["ses_rust"]["rust_engine_truth"][
                    "mc_cache_state"
                ][0]["last_activity_at"],
                int(dt.datetime(2026, 8, 27, 12, tzinfo=dt.timezone.utc).timestamp() * 1000),
            )
            self.assertEqual(
                adjacent["per_session"]["ses_rust"]["rust_engine_truth"][
                    "mc_pass_trace"
                ][0]["receive_count"],
                3,
            )
            self.assertEqual(
                adjacent["per_session"]["ses_ts"]["rust_engine_truth"][
                    "mc_cache_state"
                ],
                [],
            )

            operator = report["operator_read_state"]
            self.assertEqual(operator["unexplained_invariants"], [])
            self.assertEqual(
                operator["storage_versions"],
                {"context_db_schema_version": 99, "module_store_schema_version": 50},
            )
            rust_read = operator["per_session"]["ses_rust"]
            self.assertEqual(
                rust_read["operator_truth_sources"]["usage"], "module_read_model"
            )
            self.assertEqual(
                rust_read["operator_truth_sources"]["cache_ttl"], "context_read_model"
            )
            self.assertEqual(rust_read["module_read_model"]["compartment_count"], 1)
            self.assertEqual(rust_read["module_read_model"]["tag_count"], 2)
            self.assertEqual(
                rust_read["module_read_model"]["cache_state"][0]["last_usage"],
                {"current_total_input_tokens": 100, "context_limit_tokens": 200},
            )
            self.assertEqual(
                rust_read["module_read_model"]["mural_artifacts"][0]["content_hash"],
                "mural-hash",
            )
            self.assertEqual(
                operator["per_session"]["ses_ts"]["operator_truth_sources"]["usage"],
                "context_read_model",
            )

    def test_provider_matrix_reports_non_anthropic_empty_and_adjacency_breaks(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            temp = Path(temporary)
            dump_dir = temp / "dumps"
            dump_dir.mkdir()
            rust_root = temp / "rust-project"
            ts_root = temp / "ts-project"
            for project, mode in ((rust_root, "rust"), (ts_root, "ts")):
                (project / ".cortexkit").mkdir(parents=True)
                (project / ".cortexkit" / "magic-context.jsonc").write_text(
                    json.dumps({"transform_mode": mode})
                )
            self._write_dump(
                dump_dir, "ses_rust", rust_root, "rust-call", "github-copilot", 0
            )
            self._write_dump(dump_dir, "ses_ts", ts_root, "ts-call", "github-copilot", 0)
            ts_path = next(dump_dir.glob("*ses_ts*.body.json"))
            broken = json.loads(ts_path.read_text())
            broken["model"] = "claude-copilot-fixture"
            broken["messages"][1]["content"] = ""
            broken["messages"].insert(4, {"role": "assistant", "content": "[dropped]"})
            ts_path.write_text(json.dumps(broken))

            completed = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    str(dump_dir),
                    "--date",
                    DATE,
                    "--rust-session",
                    "ses_rust",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            matrix = json.loads(completed.stdout)["provider_matrix_parity"]
            self.assertTrue(matrix["unexplained_byte_classes"])
            self.assertEqual(
                matrix["unexplained_wire_invariants"][0]["classes"],
                ["non_anthropic_empty_content", "tool_result_adjacency_violation"],
            )
            self.assertEqual(matrix["unexplained_wire_invariants"][0]["lane"], "ts")

    def test_provider_matrix_supports_openai_responses_wire(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            temp = Path(temporary)
            dump_dir = temp / "dumps"
            dump_dir.mkdir()
            roots = {"rust": temp / "rust-project", "ts": temp / "ts-project"}
            for lane, project in roots.items():
                (project / ".cortexkit").mkdir(parents=True)
                (project / ".cortexkit" / "magic-context.jsonc").write_text(
                    json.dumps({"transform_mode": lane})
                )
                session = f"ses_response_{lane}"
                path = (
                    dump_dir
                    / f"{DATE}T12-20-00-000Z-000100-{session}-direct-sticky-main.body.json"
                )
                body = {
                    "model": "gpt-5-responses-fixture",
                    "previous_response_id": "response-before-fixture",
                    "instructions": f"Identity\nWorking directory: {project}\n\n## Magic Context",
                    "input": [
                        {
                            "type": "function_call_output",
                            "call_id": "external-call-fixture",
                            "output": "prior response result",
                        },
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "hello"}],
                        },
                        {
                            "type": "function_call",
                            "call_id": "call-fixture",
                            "name": "ctx_expand",
                            "arguments": "{}",
                        },
                        {
                            "type": "function_call",
                            "call_id": "call-fixture-2",
                            "name": "ctx_search",
                            "arguments": "{}",
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call-fixture",
                            "output": "§1§ recovered",
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call-fixture-2",
                            "output": "§2§ recovered",
                        },
                        {
                            "type": "reasoning",
                            "encrypted_content": "signed-fixture",
                            "summary": [{"type": "summary_text", "text": "summary"}],
                        },
                    ],
                }
                path.write_text(json.dumps(body))
                Path(str(path).replace(".body.json", ".meta.json")).write_text(
                    json.dumps({"status": 200, "provider_id": "openai"})
                )

            completed = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    str(dump_dir),
                    "--date",
                    DATE,
                    "--rust-session",
                    "ses_response_rust",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            matrix = json.loads(completed.stdout)["provider_matrix_parity"]
            self.assertEqual(
                matrix["inventory_by_lane"],
                {
                    "rust": {"openai:openai_responses": 1},
                    "ts": {"openai:openai_responses": 1},
                },
            )
            self.assertTrue(
                all(axis["verdict"] == "matched_value_space" for axis in matrix["axes"])
            )
            self.assertEqual(matrix["unexplained_wire_invariants"], [])

    def test_provider_matrix_does_not_compare_unlike_session_tool_counts(self) -> None:
        module = runpy.run_path(str(SCRIPT))
        dump_type = module["Dump"]

        def body(call_ids: list[str]) -> dict[str, object]:
            return {
                "model": "openai-fixture",
                "messages": [
                    {"role": "system", "content": "system"},
                    {
                        "role": "assistant",
                        "content": "calling",
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {"name": "ctx_search", "arguments": "{}"},
                            }
                            for call_id in call_ids
                        ],
                    },
                    *[
                        {"role": "tool", "tool_call_id": call_id, "content": "result"}
                        for call_id in call_ids
                    ],
                ],
            }

        dumps = [
            dump_type(Path("ts.body.json"), "ses_ts", "ts", body(["call-1"]), None),
            dump_type(
                Path("rust.body.json"),
                "ses_rust",
                "rust",
                body(["call-1", "call-2"]),
                None,
            ),
        ]
        matrix = module["compare_provider_matrix"](dumps)
        tool_axis = next(
            axis for axis in matrix["axes"] if axis["axis"] == "tool_pairing_shapes"
        )
        self.assertEqual(tool_axis["verdict"], "matched_value_space")
        self.assertEqual(
            tool_axis["shared"], ["cardinality=balanced;adjacency=valid"]
        )

    def test_live_mode_uses_read_only_coordinate_evidence(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            temp = Path(temporary)
            dump_dir = temp / "dumps"
            dump_dir.mkdir()
            rust_root = temp / "rust-project"
            ts_root = temp / "ts-project"
            for project, mode in ((rust_root, "rust"), (ts_root, "ts")):
                (project / ".cortexkit").mkdir(parents=True)
                (project / ".cortexkit" / "magic-context.jsonc").write_text(
                    json.dumps({"transform_mode": mode})
                )
            self._write_dump(dump_dir, "ses_rust", rust_root, "rust-call", "anthropic", 0)
            self._write_dump(dump_dir, "ses_ts", ts_root, "ts-call", "anthropic", 0)
            response_path = (
                dump_dir
                / f"{DATE}T12-01-00-000Z-000100-ses_ts-direct-sticky-main.body.json"
            )
            response_path.write_text(
                json.dumps(
                    {
                        "model": "gpt-5-responses-fixture",
                        "instructions": "Identity\n\n## Magic Context",
                        "input": [
                            {
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "hello"}],
                            }
                        ],
                    }
                )
            )
            response_path.with_name(
                response_path.name.replace(".body.json", ".response.json")
            ).write_text(json.dumps({"status": 200, "provider_id": "openai"}))

            context_db = temp / "context.db"
            store_db = temp / "store.db"
            opencode_db = temp / "opencode.db"
            self._write_context_db(context_db)
            self._write_store_db(store_db)
            with sqlite3.connect(context_db) as db:
                db.execute("ALTER TABLE session_projects ADD COLUMN updated_at INTEGER DEFAULT 0")
                db.execute(
                    "UPDATE session_projects SET project_path = ? WHERE session_id = 'ses_ts'",
                    (str(ts_root),),
                )
                db.execute(
                    "UPDATE session_projects SET project_path = ? WHERE session_id = 'ses_rust'",
                    (str(rust_root),),
                )
                db.execute("ALTER TABLE tags ADD COLUMN id INTEGER")
                db.execute("ALTER TABLE tags ADD COLUMN type TEXT DEFAULT 'message'")
                db.execute("ALTER TABLE tags ADD COLUMN message_id TEXT DEFAULT ''")
                db.execute("ALTER TABLE tags ADD COLUMN harness TEXT DEFAULT 'opencode'")
            with sqlite3.connect(opencode_db) as db:
                db.executescript("CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT);")
            pi_session_dir = temp / "pi-sessions"
            rpc_root = temp / "rpc"
            pi_session_dir.mkdir()
            rpc_root.mkdir()
            self._write_pi_session(pi_session_dir)

            completed = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    str(dump_dir),
                    "--live",
                    "--date",
                    DATE,
                    "--after",
                    f"{DATE}T00-00-00",
                    "--context-db",
                    str(context_db),
                    "--store-db",
                    str(store_db),
                    "--store-root",
                    str(temp),
                    "--opencode-db",
                    str(opencode_db),
                    "--pi-session-dir",
                    str(pi_session_dir),
                    "--rpc-root",
                    str(rpc_root),
                    "--skip-live-rpc",
                    "--skip-live-rust-oracle",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(completed.stdout)
            self.assertEqual(report["method"]["mode"], "live")
            self.assertEqual(report["method"]["sqlite_contract"], {"readonly": True})
            live_helper = (ROOT / "scripts" / "audit-transform-wire-parity-live.ts").read_text()
            self.assertEqual(live_helper.count("new Database("), 1)
            self.assertIn("new Database(path, { readonly: true })", live_helper)
            self.assertTrue(
                report["live_probe"]["method"]["sqlite_query_only_verified"]
            )
            evidence = report["provider_live"]["evidence"]
            self.assertEqual(len(evidence), 3)
            self.assertTrue(all(len(row["session_prefix"]) <= 8 for row in evidence))
            self.assertTrue(all(len(row["capture_sha256"]) == 64 for row in evidence))
            self.assertNotIn(str(temp), completed.stdout)
            self.assertEqual(
                {row["session_prefix"] for row in evidence},
                {"ses_rust"[:8], "ses_ts"[:8]},
            )
            responses = [
                row
                for row in evidence
                if row["provider_family"] == "openai:openai_responses"
            ]
            self.assertEqual([row["lane"] for row in responses], ["ts"])
            self.assertEqual(
                report["provider_live"]["lane_coordinate_coverage"],
                {
                    "resolved_dumps": 1,
                    "remaining_unverified_dumps": 0,
                    "ambiguous_capture_hashes": [],
                    "coordinate_requested_hashes": 2,
                    "coordinate_resolved_hashes": 2,
                    "rule": "served project roots win; otherwise only a collision-free twelve-character session hash joined to a readable live project config enters a lane denominator",
                },
            )

    def _write_dump(
        self,
        dump_dir: Path,
        session: str,
        project: Path,
        call_id: str,
        provider: str,
        minute: int,
    ) -> None:
        name = f"{DATE}T12-{minute:02d}-00-000Z-000001-{session}-direct.body.json"
        recovery = "§42§ [7] A (assistant) — full recovery:\n\n  [text]\nhello"
        if provider in ("anthropic", "bedrock"):
            body = {
                "model": "claude-fixture",
                "system": [{"type": "text", "text": f"Working directory: {project}"}],
                "messages": [
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "redacted_thinking",
                                "data": "opaque-plan",
                                "signature": f"sig-{provider}",
                            },
                            {
                                "type": "tool_use",
                                "id": call_id,
                                "name": "ctx_expand",
                                "input": {"message": 7},
                            },
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": call_id,
                                "content": recovery,
                            }
                        ],
                    },
                ],
            }
        elif provider == "google":
            body = {
                "model": "gemini-fixture",
                "systemInstruction": {
                    "parts": [{"text": f"Working directory: {project}"}]
                },
                "contents": [
                    {"role": "model", "parts": [{"text": "[dropped]"}]},
                    {"role": "user", "parts": [{"text": "continue"}]},
                    {
                        "role": "model",
                        "parts": [
                            {
                                "text": "plan",
                                "thought": True,
                                "thoughtSignature": "gemini-signature",
                            },
                            {
                                "functionCall": {
                                    "id": call_id,
                                    "name": "ctx_expand",
                                    "args": {"message": 7},
                                }
                            },
                        ],
                    },
                    {
                        "role": "user",
                        "parts": [
                            {
                                "functionResponse": {
                                    "id": call_id,
                                    "name": "ctx_expand",
                                    "response": {"content": recovery},
                                }
                            }
                        ],
                    },
                ],
            }
        else:
            body = {
                "model": f"{provider}-fixture",
                "messages": [
                    {"role": "system", "content": f"Working directory: {project}"},
                    {"role": "assistant", "content": "[dropped]"},
                    {"role": "user", "content": "continue"},
                    {
                        "role": "assistant",
                        "content": "answer",
                        "reasoning_content": "plan",
                        "reasoning_signature": f"sig-{provider}",
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": "ctx_expand",
                                    "arguments": json.dumps({"message": 7}),
                                },
                            }
                        ],
                    },
                    {"role": "tool", "tool_call_id": call_id, "content": recovery},
                ],
            }
        path = dump_dir / name
        path.write_text(json.dumps(body))
        path.with_name(name.replace(".body.json", ".response.json")).write_text(
            json.dumps(
                {
                    "status": 200,
                    "provider_id": provider,
                    "usage": {"input_tokens": 100},
                }
            )
        )

    def _write_pi_session(self, directory: Path) -> None:
        entries = [
            {
                "type": "session",
                "id": "pi_session",
                "cwd": "/fixture/project",
                "timestamp": "2026-08-27T12:00:00Z",
            },
            {
                "type": "message",
                "id": "pi-user-1",
                "message": {"role": "user", "content": "§1§ hello", "timestamp": 1},
            },
            {
                "type": "message",
                "id": "pi-tool-1",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "pi-call",
                    "toolName": "ctx_expand",
                    "content": [{"type": "text", "text": "§42§ recovered"}],
                    "timestamp": 2,
                },
            },
        ]
        (directory / "pi-session.jsonl").write_text(
            "".join(json.dumps(entry) + "\n" for entry in entries)
        )

    def _write_pi_render(self, directory: Path, project: Path) -> None:
        capture = {
            "session_id": "pi_session",
            "project_root": str(project),
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "pi-call",
                            "name": "ctx_expand",
                            "arguments": {"message": 7},
                        }
                    ],
                },
                {
                    "role": "toolResult",
                    "toolCallId": "pi-call",
                    "toolName": "ctx_expand",
                    "content": [
                        {
                            "type": "text",
                            "text": "§42§ [7] A (assistant) — full recovery:\n\n  [text]\nhello",
                        }
                    ],
                },
            ],
        }
        (directory / f"{DATE}T12-00-00.pi-render.json").write_text(json.dumps(capture))

    def _write_context_db(self, path: Path) -> None:
        with sqlite3.connect(path) as db:
            db.executescript(
                """
                CREATE TABLE schema_migrations (version INTEGER);
                INSERT INTO schema_migrations VALUES (99);
                CREATE TABLE transform_decisions (
                    session_id TEXT, ts_ms INTEGER, decision TEXT, materialize_reason TEXT,
                    input_tokens INTEGER, emergency INTEGER, dropped_count INTEGER,
                    system_hash_prev TEXT, system_hash_new TEXT, m0_model_key_prev TEXT,
                    m0_model_key_new TEXT, m0_tool_set_hash_prev TEXT, m0_tool_set_hash_new TEXT
                );
                CREATE TABLE tags (
                    session_id TEXT, caveman_depth INTEGER, tag_number INTEGER,
                    status TEXT, byte_size INTEGER
                );
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY, last_context_percentage REAL,
                    last_input_tokens INTEGER, last_usage_context_limit INTEGER,
                    cache_ttl TEXT, last_response_time INTEGER, counter INTEGER,
                    cached_m0_mural_hash TEXT
                );
                CREATE TABLE compartments (
                    id INTEGER PRIMARY KEY, session_id TEXT, harness TEXT, sequence INTEGER,
                    start_message INTEGER, end_message INTEGER, p1 TEXT, p2 TEXT, p3 TEXT,
                    p4 TEXT, importance INTEGER, legacy INTEGER, created_at INTEGER
                );
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY, project_path TEXT, source_session_id TEXT,
                    category TEXT, content TEXT, normalized_hash TEXT, importance INTEGER,
                    source_type TEXT, created_at INTEGER
                );
                CREATE TABLE message_history_index (
                    session_id TEXT PRIMARY KEY, last_indexed_ordinal INTEGER,
                    dirty_floor_ordinal INTEGER, harness TEXT
                );
                CREATE TABLE message_history_fts (
                    session_id TEXT, message_ordinal INTEGER, message_id TEXT, role TEXT,
                    content TEXT
                );
                CREATE TABLE session_projects (
                    session_id TEXT, harness TEXT, project_path TEXT
                );
                CREATE TABLE compartment_chunk_embeddings (
                    compartment_id INTEGER, session_id TEXT, project_path TEXT, harness TEXT
                );
                CREATE TABLE memory_embeddings (memory_id INTEGER, model_id TEXT);
                CREATE TABLE notes (
                    session_id TEXT, type TEXT, status TEXT, check_status TEXT
                );
                CREATE TABLE git_commits (project_path TEXT, sha TEXT);
                CREATE TABLE mural_manifest (
                    project_path TEXT PRIMARY KEY, content_hash TEXT, rendered_at INTEGER,
                    width INTEGER, height INTEGER, memory_ids_json TEXT
                );
                CREATE TABLE compartment_events (
                    session_id TEXT, kind TEXT, at_compartment INTEGER, created_at INTEGER
                );
                """
            )
            now = int(
                dt.datetime(2026, 8, 27, 12, tzinfo=dt.timezone.utc).timestamp() * 1000
            )
            db.executemany(
                "INSERT INTO session_meta VALUES (?, ?, ?, ?, 'never', ?, ?, ?)",
                [
                    ("ses_ts", 50.0, 100, 200, now, 2, "mural-hash"),
                    ("ses_rust", 50.0, 100, 200, now, 2, "mural-hash"),
                ],
            )
            db.executemany(
                "INSERT INTO tags VALUES (?, 0, ?, ?, ?)",
                [
                    ("ses_ts", 1, "active", 10),
                    ("ses_ts", 2, "dropped", 20),
                    ("ses_rust", 1, "active", 10),
                ],
            )
            db.execute(
                "INSERT INTO transform_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("ses_ts", now, "defer", None, 100, 0, 0, "a", "a", "m", "m", "t", "t"),
            )
            db.execute(
                "INSERT INTO compartments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (1, "ses_ts", "opencode", 1, 1, 4, "p1", "p2", "p3", "p4", 61, 0, now),
            )
            db.execute(
                "INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (1, "git:ts", "ses_ts", "workflow", "ts fact", "ts-hash", 50, "historian", now),
            )
            db.executemany(
                "INSERT INTO message_history_index VALUES (?, 1, NULL, 'opencode')",
                [("ses_ts",), ("ses_rust",)],
            )
            db.executemany(
                "INSERT INTO message_history_fts VALUES (?, 1, ?, 'user', ?)",
                [
                    ("ses_ts", "ts-message", "identical searchable bytes"),
                    ("ses_rust", "rust-message", "identical searchable bytes"),
                ],
            )
            db.executemany(
                "INSERT INTO session_projects VALUES (?, 'opencode', ?)",
                [("ses_ts", "git:ts"), ("ses_rust", "git:rust")],
            )
            db.executemany(
                "INSERT INTO compartment_chunk_embeddings VALUES (?, ?, ?, 'opencode')",
                [(1, "ses_ts", "git:ts"), (2, "ses_rust", "git:rust")],
            )
            db.execute("INSERT INTO memory_embeddings VALUES (1, 'fixture-model')")
            db.executemany(
                "INSERT INTO notes VALUES (?, 'smart', 'active', 'compiled')",
                [("ses_ts",), ("ses_rust",)],
            )
            db.executemany(
                "INSERT INTO git_commits VALUES (?, ?)",
                [("git:ts", "abcdef1"), ("git:rust", "abcdef2")],
            )
            db.executemany(
                "INSERT INTO mural_manifest VALUES (?, 'mural-hash', ?, 16, 8, '[1]')",
                [("git:ts", now), ("git:rust", now)],
            )
            db.execute(
                "INSERT INTO compartment_events VALUES (?, ?, ?, ?)",
                ("ses_ts", "decision", 1, now),
            )

    def _write_store_db(self, path: Path) -> None:
        with sqlite3.connect(path) as db:
            db.executescript(
                """
                CREATE TABLE cortexkit_schema_version (namespace TEXT, version INTEGER);
                CREATE TABLE mc_cache_state (
                    session_id TEXT, last_activity_at INTEGER, meta TEXT
                );
                CREATE TABLE mc_pass_trace (
                    session_id TEXT, scheduler_history TEXT,
                    scheduler_interesting_history TEXT, last_received_at_ms INTEGER,
                    last_completed_at_ms INTEGER, last_reject_error TEXT,
                    last_reject_at_ms INTEGER, receive_count INTEGER, reject_count INTEGER,
                    first_divergence TEXT
                );
                CREATE TABLE mc_tags (session_id TEXT, tag_number INTEGER);
                CREATE TABLE pending_agent_drops (session_id TEXT, id INTEGER);
                CREATE TABLE mc_project_mural_artifacts (
                    project_path TEXT, data_url BLOB, content_hash TEXT, updated_at INTEGER
                );
                CREATE TABLE mc_compartments (
                    session_id TEXT, sequence INTEGER, start_message INTEGER, end_message INTEGER,
                    start_date TEXT, end_date TEXT, p1 TEXT, p2 TEXT, p3 TEXT, p4 TEXT,
                    importance INTEGER, legacy INTEGER, created_at INTEGER
                );
                CREATE TABLE mc_memories (
                    source_session_id TEXT, category TEXT, content TEXT, importance INTEGER,
                    source_type TEXT, created_at INTEGER
                );
                CREATE TABLE mc_historian_side_channel_outbox (
                    session_id TEXT, kind TEXT, firing_seq INTEGER, source_start INTEGER,
                    source_end INTEGER, attempt_count INTEGER, delivered_at_ms INTEGER,
                    last_error TEXT, created_at_ms INTEGER
                );
                """
            )
            now = int(
                dt.datetime(2026, 8, 27, 12, tzinfo=dt.timezone.utc).timestamp() * 1000
            )
            db.execute("INSERT INTO cortexkit_schema_version VALUES ('mc_cache', 50)")
            db.execute(
                "INSERT INTO mc_cache_state VALUES (?, ?, ?)",
                (
                    "ses_rust",
                    now,
                    json.dumps(
                        {
                            "initialized": True,
                            "caveman_age_basis_tag": 9,
                            "last_usage": {
                                "current_total_input_tokens": 100,
                                "context_limit_tokens": 200,
                            },
                        }
                    ),
                ),
            )
            db.executemany(
                "INSERT INTO mc_tags VALUES (?, ?)",
                [("ses_rust", 1), ("ses_rust", 2)],
            )
            db.execute("INSERT INTO pending_agent_drops VALUES ('ses_rust', 1)")
            db.execute(
                "INSERT INTO mc_project_mural_artifacts VALUES (?, ?, 'mural-hash', ?)",
                ("git:rust", b"data:image/png;base64,cG5n", now),
            )
            db.execute(
                "INSERT INTO mc_pass_trace VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("ses_rust", "[]", "[]", now, now, None, None, 3, 0, None),
            )
            db.execute(
                "INSERT INTO mc_compartments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "ses_rust",
                    1,
                    1,
                    4,
                    "2026-08-27",
                    "2026-08-27",
                    "p1",
                    "p2",
                    "p3",
                    "p4",
                    63,
                    0,
                    now,
                ),
            )
            db.execute(
                "INSERT INTO mc_memories VALUES (?, ?, ?, ?, ?, ?)",
                ("ses_rust", "workflow", "rust fact", 50, "historian", now),
            )
            db.execute(
                "INSERT INTO mc_historian_side_channel_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("ses_rust", "event", 1, 1, 4, 0, now, None, now),
            )


if __name__ == "__main__":
    unittest.main()
