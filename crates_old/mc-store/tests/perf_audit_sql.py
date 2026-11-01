"""SQL-only RS audit fallback. timeout 120 python3 crates/mc-store/tests/perf_audit_sql.py.

Always uses temporary fixtures; never opens live stores. The Rust instrument measures
the full implementations. This isolates SQLite's transaction/commit and scan costs.
"""
import pathlib
import sqlite3
import statistics
import tempfile
import time

print("Python SQLite", sqlite3.sqlite_version)
schema = pathlib.Path("crates/mc-module/tests/fixtures/context-db-schema.sql").read_text()
for count in (1000, 10000, 60000):
    with tempfile.TemporaryDirectory(prefix="mc-rs-perf-") as root:
        db = sqlite3.connect(pathlib.Path(root) / "context.db", isolation_level=None)
        db.executescript(schema)
        assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        db.execute("BEGIN IMMEDIATE")
        db.executemany("INSERT INTO tags(session_id,message_id,type,byte_size,tag_number,token_count,entry_fingerprint) VALUES ('s',?,'text',512,?,128,?)",
                       ((f"m{i}", i + 1, f"fp{i}") for i in range(count)))
        db.execute("COMMIT")
        for synchronous in ("FULL", "NORMAL"):
            db.execute(f"PRAGMA synchronous={synchronous}")
            samples = []
            for i in range(100):
                db.execute("BEGIN IMMEDIATE")
                start = time.perf_counter_ns()
                db.execute("UPDATE tags SET token_count=? WHERE session_id='s' AND tag_number=1", (i,))
                db.execute("COMMIT")
                samples.append((time.perf_counter_ns() - start) / 1000)
            print(f"messages={count} synchronous={synchronous} lock_us median={statistics.median(samples):.1f} p95={sorted(samples)[94]:.1f} writes=100")
        plan = db.execute("EXPLAIN QUERY PLAN SELECT content FROM memories WHERE project_path=? AND status IN ('active','permanent') AND content=?", ("p", "fact")).fetchall()
        print("RS2/RS14 exact content probe:", plan)
        db.close()
print("3 fixtures, 600 lock-held writes measured")
