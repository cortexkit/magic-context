interface Range {
	start: number;
	end: number;
}
interface Truncation {
	direction: string;
	truncatedBy: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	shownRange?: Range;
	headRange?: Range;
	tailRange?: Range;
	elidedBytes?: number;
	elidedLines?: number;
	artifactId?: string;
	artifactElidedBytes?: number;
	nextOffset?: number;
	partialLine?: boolean;
}
interface Meta {
	truncation?: Truncation;
	artifactError?: string;
	source?: { type: string; value: string };
	diagnostics?: { summary: string; messages: string[] };
	limits?: {
		matchLimit?: { reached: number; suggestion: number };
		resultLimit?: { reached: number; suggestion?: number };
		headLimit?: { reached: number; suggestion: number };
		columnTruncated?: {
			maxColumn: number;
			unit?: string;
			artifactId?: string;
			artifactElidedBytes?: number;
			lines?: { first: number; last: number };
			selectorBase?: string;
			rawByteCap?: number;
		};
	};
}

const bytes = (n: number) =>
	n < 1024
		? `${n}B`
		: n < 1024 ** 2
			? `${(n / 1024).toFixed(1)}KB`
			: n < 1024 ** 3
				? `${(n / 1024 ** 2).toFixed(1)}MB`
				: `${(n / 1024 ** 3).toFixed(1)}GB`;
const artifact = (id: string, missing?: number) =>
	missing !== undefined && missing > 0
		? `Read artifact://${id} for a head/tail sample of the output; ${bytes(missing)} from its middle was not saved`
		: `Read artifact://${id} for full output`;

function truncation(t: Truncation, source: Meta["source"]): string {
	const reference =
		t.artifactId == null
			? undefined
			: source?.type === "report"
				? `Read artifact://${t.artifactId} for full report (${source.value})`
				: artifact(t.artifactId, t.artifactElidedBytes);
	let text: string;
	if (t.direction === "middle") {
		const head = t.headRange
			? `lines ${t.headRange.start}-${t.headRange.end}`
			: "";
		const tail = t.tailRange
			? `lines ${t.tailRange.start}-${t.tailRange.end}`
			: "";
		const hiddenBytes =
			t.elidedBytes ?? Math.max(0, t.totalBytes - t.outputBytes);
		const hiddenLines =
			t.elidedLines ?? Math.max(0, t.totalLines - t.outputLines);
		text =
			head && tail
				? `Showing ${head} and ${tail} of ${t.totalLines}; ${hiddenLines.toLocaleString()} middle line${hiddenLines === 1 ? "" : "s"} (${bytes(hiddenBytes)}) elided`
				: hiddenBytes > 0
					? `Showing head and tail bytes of ${t.totalLines.toLocaleString()} line${t.totalLines === 1 ? "" : "s"}; ${bytes(hiddenBytes)} elided`
					: `Showing ${Math.min(t.outputLines, t.totalLines)} of ${t.totalLines} lines; middle elided`;
	} else if (t.partialLine)
		text = `Showing line ${t.shownRange?.start ?? 1} (partial, ${bytes(t.outputBytes)} of ${bytes(t.totalBytes)}) of ${t.totalLines}`;
	else {
		text = t.shownRange
			? `Showing lines ${t.shownRange.start}-${t.shownRange.end} of ${t.totalLines}`
			: `Showing ${t.outputLines} of ${t.totalLines} lines`;
		if (t.truncatedBy === "bytes")
			text += ` (${bytes(t.maxBytes ?? t.outputBytes)} limit)`;
	}
	if (!t.partialLine && t.nextOffset != null)
		text += `. Use :${t.nextOffset} to continue`;
	if (reference) text += `. ${reference}`;
	return text;
}

function diagnosticGroups(messages: string[]): string {
	interface Node {
		files: string[];
		dirs: Map<string, Node>;
	}
	const node = (): Node => ({ files: [], dirs: new Map() });
	const root = node();
	const byFile = new Map<string, string[]>();
	const ungrouped: string[] = [];
	for (const text of messages) {
		const match = /^(.+?):(\d+:\d+\s+.*)$/u.exec(text);
		if (!match) {
			ungrouped.push(text);
			continue;
		}
		const path = match[1].replace(/\\/gu, "/");
		if (!byFile.has(path)) {
			const parts = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)
				? [path]
				: path.split("/");
			let current = root;
			for (const part of parts.slice(0, -1)) {
				if (!current.dirs.has(part)) current.dirs.set(part, node());
				current = current.dirs.get(part)!;
			}
			current.files.push(path);
			byFile.set(path, []);
		}
		byFile.get(path)!.push(match[2]);
	}
	if (!byFile.size) return ungrouped.join("\n");
	const lines: string[] = [];
	const emit = (header: string, depth: number, directory: boolean) => {
		if (lines.length && (directory || depth === 0)) lines.push("");
		lines.push(`${"#".repeat(depth + 1)} ${header}`);
	};
	const walk = (current: Node, depth: number) => {
		for (const path of current.files) {
			emit(
				/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)
					? path
					: path.slice(path.lastIndexOf("/") + 1),
				depth,
				false,
			);
			lines.push(...byFile.get(path)!.map((text) => `  ${text}`));
		}
		for (const [name, child] of current.dirs) {
			let next = child;
			const parts = [name];
			while (!next.files.length && next.dirs.size === 1) {
				const [name, child] = next.dirs.entries().next().value!;
				parts.push(name);
				next = child;
			}
			emit(`${parts.join("/")}/`, depth, true);
			walk(next, depth + 1);
		}
	};
	walk(root, 0);
	if (ungrouped.length) lines.push("", ...ungrouped);
	return lines.join("\n");
}

/** Model-visible execution suffix from OMP 18.18.6 pi-tui/tools/output-meta.ts. */
export function piOmpOutputNotice(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error("unreadable output metadata");
	const meta = value as Meta;
	const parts: string[] = [];
	if (meta.truncation) parts.push(truncation(meta.truncation, meta.source));
	if (meta.artifactError)
		parts.push(
			`Full output was not saved completely (artifact ${meta.artifactError} failed)`,
		);
	if (meta.limits?.matchLimit) {
		const limit = meta.limits.matchLimit;
		parts.push(
			`${limit.reached} matches limit reached. Use limit=${limit.suggestion} for more`,
		);
	}
	if (meta.limits?.resultLimit) {
		const limit = meta.limits.resultLimit;
		parts.push(
			limit.suggestion === undefined
				? `${limit.reached} results limit reached`
				: `${limit.reached} results limit reached. Use limit=${limit.suggestion} for more`,
		);
	}
	if (meta.limits?.headLimit) {
		const limit = meta.limits.headLimit;
		parts.push(
			`${limit.reached} results limit reached. Use limit=${limit.suggestion} for more`,
		);
	}
	if (meta.limits?.columnTruncated) {
		const limit = meta.limits.columnTruncated;
		let text = `Some lines truncated to ${limit.maxColumn} ${limit.unit ?? "chars"}`;
		const base =
			limit.selectorBase ??
			(limit.artifactId != null && !limit.artifactElidedBytes
				? `artifact://${limit.artifactId}`
				: undefined);
		if (limit.lines && base !== undefined) {
			const { first, last } = limit.lines;
			text +=
				limit.rawByteCap === undefined
					? `. Use ${base}:raw:${first}-${first} to read line ${first} whole`
					: `. Use ${base}:raw:${first}-${first} to read line ${first} uncut, byte-capped at ${bytes(limit.rawByteCap)}`;
			if (last > first)
				text += `; cut lines run to line ${last}, each read the same way`;
		} else if (limit.artifactId != null)
			text += `. ${artifact(limit.artifactId, limit.artifactElidedBytes)}`;
		parts.push(text);
	}
	const diagnostics = meta.diagnostics?.messages.length
		? `\n\nLSP Diagnostics (${meta.diagnostics.summary}):\n${diagnosticGroups(meta.diagnostics.messages)}`
		: "";
	return (parts.length ? `\n\n[${parts.join(". ")}]` : "") + diagnostics;
}
