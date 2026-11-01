# App read fixtures

Throwaway inputs for the session, memory, dreamer, health and config reads.
Tests copy these files into a temporary directory or apply SQL to a database
created beside a temporary store. Nothing here points at a live store or a
live config file.

`apply_sql.py` runs a SQL script against the database path given as its first
argument. The script arrives on standard input. The Rust tests use it so their
own sources stay free of writer calls.

`config/user.json` and `config/project.json` each contain a secret-named value
in a different place: a top-level key, a nested key, a headers map, a password,
a token, and the project file. The config read must replace every one of those
values and leave the neighbouring non-secret fields readable.

`lists.sql` seeds the paged sections with independent rows. `project-catalog.sql`
expands `__MEMORY_COUNT__` to 30,000 or 300,000 for the catalog timing fixture;
that fixture also adds 5,000 runs and 720 scheduler rows across 60 paths.
`legacy-project-paths.json` includes the dashboard's checked-in lexical identity
vectors plus trailing-slash, parent-component and identity-preservation cases.
The normalizer deliberately keeps `/private/var` distinct from `/var`: it does
not follow symlinks or inspect files while reading historical paths.
