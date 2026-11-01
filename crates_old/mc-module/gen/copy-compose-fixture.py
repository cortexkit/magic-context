#!/usr/bin/env python3
"""Copy one session and its project render inputs from a read-only module store.

The output contains private history and memories. Keep it outside version control.
Usage: python3 copy-compose-fixture.py SOURCE_DB OUTPUT_DIRECTORY SESSION PROJECT
"""
import json
import pathlib
import sqlite3
import sys

source, output, session, project = sys.argv[1:]
root = pathlib.Path(output)
root.mkdir(parents=True, exist_ok=True)
destination = root / "store.db"
if destination.exists():
    raise SystemExit("refusing to overwrite an existing fixture")
src = sqlite3.connect(pathlib.Path(source).resolve().as_uri() + "?mode=ro", uri=True)
src.execute("BEGIN")
dst = sqlite3.connect(destination)
schema = src.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").fetchall()
for kind, name, sql in schema:
    if kind == "table":
        dst.execute(sql)
for kind, name, sql in schema:
    if kind != "table":
        continue
    columns = [row[1] for row in src.execute(f'PRAGMA table_info("{name}")')]
    if name in ("cortexkit_schema_version", "cortexkit_fence", "mc_user_memories"):
        predicate, args = "1", ()
    elif "project_path" in columns:
        predicate, args = "project_path = ?", (project,)
    elif "session_id" in columns:
        predicate, args = "session_id = ?", (session,)
    else:
        continue
    rows = src.execute(f'SELECT * FROM "{name}" WHERE {predicate}', args).fetchall()
    if rows:
        dst.executemany(f'INSERT INTO "{name}" VALUES ({",".join("?" for _ in columns)})', rows)
for kind, name, sql in schema:
    if kind in ("index", "trigger", "view"):
        dst.execute(sql)
dst.commit()
src.row_factory = sqlite3.Row
rows = [dict(row) for row in src.execute("SELECT * FROM mc_compartments WHERE session_id=? ORDER BY sequence", (session,))]
(root / "compartments.json").write_text(json.dumps(rows))
(root / "manifest.json").write_text(json.dumps({"session": session, "project": project, "compartments": len(rows)}, indent=2))
print(f"copied {len(rows)} compartments to {destination}; source opened mode=ro")
