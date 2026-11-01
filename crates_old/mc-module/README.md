# ck-mc (mc-module)

The Magic Context subc module: the harness-agnostic cache-stability transform, backed by the
single-writer `mc-store`, served over the subc wire. The built executable is `ck-mc`; the crate and
the module id (`magic-context`) keep their own names.

## Store compatibility and rollback

The module's store applies every migration it ships on open. A store written by a **newer** ck-mc
than the one opening it is normally tolerated: the newer migrations are skipped, a line is logged,
and the older binary serves what it understands. That tolerance is what makes replacing a ck-mc
build with an earlier one a supported recovery step for ordinary changes.

**Rolling ck-mc back across the single-store change is not supported.** The single-store change
moves the project rows (memories, notes, compartments and their side tables) out of the module's
own store and into the host's database, and records that it did so with a marker in the store. Once
that marker is set, the rows an older binary knows how to read are no longer the rows being
written, so an older binary that opened the store would answer every request from a stale copy and
never say so. Instead it refuses to open the store at all, names the reason
(`single_store_marker`), and tells the operator which build to run. There is no downgrade path and
no automatic repair: recovering an older build means restoring the store from a backup taken before
the move.

Builds from before the marker existed cannot even see it. That is why the marker's schema is
shipped ahead of the move itself: every build that could meet a migrated store already knows how to
recognise one and stop.
