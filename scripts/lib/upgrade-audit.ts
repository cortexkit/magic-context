import { Database } from "bun:sqlite";
import { realpathSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { movedPayloadDifference, type PayloadProof } from "./upgrade-payloads";

export const quote = (name: string): string =>
	`"${name.replaceAll('"', '""')}"`;
export const NOW = 1_800_000_000_000;

export function hashFile(path: string): string {
    const fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const digest = new Bun.CryptoHasher("sha256");
    try {
        let count: number;
        while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
            digest.update(buffer.subarray(0, count));
        return digest.digest("hex");
    } finally { closeSync(fd); }
}

export function snapshotRoot(path: string): string {
	const requested = resolve(path);
	// A snapshot is an operator-supplied offline copy, never a live storage root.
	for (const forbidden of [
		join(homedir(), ".local/share/cortexkit/magic-context"),
		join(homedir(), ".local/share/opencode"),
		join(homedir(), ".config/opencode"),
		join(homedir(), ".config/cortexkit"),
	]) {
		if (requested === forbidden || requested.startsWith(`${forbidden}/`)) {
			throw new Error(`Refusing live storage root: ${requested}`);
		}
	}
	const root = realpathSync(requested);
	for (const forbidden of [
		join(homedir(), ".local/share/cortexkit/magic-context"),
		join(homedir(), ".local/share/opencode"),
		join(homedir(), ".config/opencode"),
		join(homedir(), ".config/cortexkit"),
	]) {
		if (root === forbidden || root.startsWith(`${forbidden}/`))
			throw new Error(`Refusing live storage root: ${root}`);
	}
	if (!statSync(root).isDirectory())
		throw new Error(
			"--snapshot requires an offline context.db directory",
		);
	for (const name of ["context.db"]) {
		if (statSync(join(root, `${name}-wal`), { throwIfNoEntry: false })) throw new Error("Snapshot must be an offline context.db without WAL sidecars");
		const file = realpathSync(join(root, name));
		if (file !== join(root, name))
			throw new Error(`Snapshot database must not be a symlink: ${name}`);
	}
	return root;
}

export function version(path: string): number {
	const db = new Database(path, { readonly: true });
	try {
		const sql = "SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000";
		return Number((db.query(sql).get() as { v: number }).v);
	} finally {
		db.close();
	}
}

export function versionAfterCrash(path: string): number {
	// A killed DELETE-journal writer may have spilled pages. Let SQLite roll
	// those pages back before asking a read-only connection for the ledger.
	const db = new Database(path, { create: false, readwrite: true });
	try {
		db.query("PRAGMA schema_version").get();
	} finally {
		db.close();
	}
	return version(path);
}

export function inventory(path: string): Record<string, number> {
	const db = new Database(path, { readonly: true });
	try {
		const names = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		return Object.fromEntries(
			names.map(({ name }) => [
				name,
				Number(
					(
						db.query(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as {
							n: number;
						}
					).n,
				),
			]),
		);
	} finally {
		db.close();
	}
}

export function firstDifference(
	before: string,
	after: string,
	onlyTables?: readonly string[],
	proofs?: { payloads: PayloadProof[]; tables: { name: string; rows: number; sha256: string }[] },
): string | null {
	const db = new Database(after, { readonly: true });
	try {
		db.query("ATTACH DATABASE ? AS baseline").run(before);
		const tables = db.query("PRAGMA baseline.table_list").all() as {
			name: string;
			type: string;
			wr: number;
			schema: string;
		}[];
		if (onlyTables) {
			for (const name of onlyTables) {
				if (!tables.some((table) =>
					table.schema === "baseline" && table.name === name &&
					(table.type === "table" || table.type === "virtual"),
				)) {
					throw new Error(`Preservation table not present in baseline: ${name}`);
				}
			}
		}
		for (const table of tables.sort((a, b) => a.name.localeCompare(b.name))) {
			const name = table.name;
			if (
				table.schema !== "baseline" ||
				(table.type !== "table" && table.type !== "virtual") ||
				name.startsWith("sqlite_") ||
				(onlyTables && !onlyTables.includes(name))
			)
				continue;
			const oldColumns = db
				.query(`PRAGMA baseline.table_info(${quote(name)})`)
				.all() as { name: string }[];
			const newColumns = new Set(
				(
					db.query(`PRAGMA main.table_info(${quote(name)})`).all() as {
						name: string;
					}[]
				).map((c) => c.name),
			);
			const removed = oldColumns.filter((c) => !newColumns.has(c.name));
			if (removed.length) {
				if (name !== "session_meta") return `${name}: removed column ${removed[0].name}`;
				const difference = movedPayloadDifference(db, removed.map((c) => c.name), proofs?.payloads ?? []);
				if (difference) return difference;
			}
			const columns = oldColumns.filter((c) => newColumns.has(c.name)).map((c) => quote(c.name)).join(",");
			// Ledger advancement is expected, but old context migration identities must survive.
			const filter = name === "schema_migrations"
                ? " WHERE version IN (SELECT version FROM baseline.schema_migrations)"
                : "";
			const fields =
				table.wr || table.type === "virtual"
					? columns
					: `rowid AS __rowid,${columns}`;
			const old = `SELECT ${fields} FROM baseline.${quote(name)}${filter}`;
			const next = `SELECT ${fields} FROM main.${quote(name)}${filter}`;
			for (const [label, left, right] of [
				["lost/changed", old, next],
				["added/changed", next, old],
			]) {
				const row = db
					.query(`SELECT * FROM (${left} EXCEPT ${right}) LIMIT 1`)
					.get();
				if (row)
					return `${name}: ${label} row ${JSON.stringify(row, (_key, value) => (value instanceof Uint8Array ? { blob: Buffer.from(value).toString("hex") } : typeof value === "bigint" ? value.toString() : value))}`.slice(
						0,
						2000,
					);
			}
			const counts = db
				.query(
					`SELECT (SELECT COUNT(*) FROM (${old})) AS old, (SELECT COUNT(*) FROM (${next})) AS next`,
				)
				.get() as { old: number; next: number };
			if (counts.old !== counts.next)
				return `${name}: row count ${counts.old} -> ${counts.next}`;
			if (proofs) {
				const hashes = [old, next].map((sql) => {
					const digest = new Bun.CryptoHasher("sha256");
					for (const row of db.query(`${sql} ORDER BY ${table.wr ? columns : "rowid"}`).iterate())
						digest.update(JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? { blob: Buffer.from(value).toString("hex") } : typeof value === "bigint" ? value.toString() : value) + "\n");
					return digest.digest("hex");
				});
				if (hashes[0] !== hashes[1]) return `${name}: row checksum differs`;
				proofs.tables.push({ name, rows: counts.old, sha256: hashes[0] });
			}
		}
		return null;
	} finally {
		db.close();
	}
}

export function integrity(path: string): {
	bytes: number;
	integrity: string[];
	checkpoint: unknown;
} {
	const db = new Database(path);
	try {
		const checks = (
			db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]
		).map((r) => r.integrity_check);
		if (checks.length !== 1 || checks[0] !== "ok")
			throw new Error(`${path}: integrity_check: ${checks.join("; ")}`);
		const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
			busy: number;
		};
		if (checkpoint.busy !== 0) throw new Error(`${path}: WAL checkpoint busy`);
		return { bytes: statSync(path).size, integrity: checks, checkpoint };
	} finally {
		db.close();
	}
}

/** Compare captured provider payload fields, not a local renderer's output. */
export function compareServedBodies(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
) {
	return Object.fromEntries(["system", "messages", "tools"].map((part) => {
		const left = JSON.stringify(before[part]) ?? "null";
		const right = JSON.stringify(after[part]) ?? "null";
		const a = Buffer.from(left);
		const b = Buffer.from(right);
		let offset = 0;
		while (offset < a.length && a[offset] === b[offset]) offset++;
		const hash = (text: string) =>
			new Bun.CryptoHasher("sha256").update(text).digest("hex");
		return [part, {
			equal: left === right,
			bytesBefore: a.length,
			bytesAfter: b.length,
			sha256Before: hash(left),
			sha256After: hash(right),
			firstDifference: left === right ? null : offset,
			beforeExcerpt: left === right ? null :
				a.subarray(Math.max(0, offset - 60), offset + 180).toString(),
			afterExcerpt: left === right ? null :
				b.subarray(Math.max(0, offset - 60), offset + 180).toString(),
		}];
	}));
}

/** Exact DDL digest is diagnostic; structural compatibility is checked separately. */
export function schemaDigest(path: string): string {
    const db = new Database(path, { readonly: true });
    try {
        const rows = db
            .query(
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
            )
            .all();
        return new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex");
    } finally {
        db.close();
    }
}
