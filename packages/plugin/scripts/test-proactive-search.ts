#!/usr/bin/env bun
/**
 * Experiment: test whether heuristic keyword extraction from user messages
 * can produce useful ctx_search hits for proactive nudging.
 *
 * Reads user messages from the current (or specified) session, extracts
 * search terms, runs FTS-only search against memories and facts, and
 * reports what a proactive nudge would have triggered.
 *
 * Usage:
 *   bun scripts/test-proactive-search.ts [sessionId] [--limit N] [--threshold 0.3]
 */
import { Database } from "bun:sqlite";

// ─── Config ──────────────────────────────────────────────

const OPENCODE_DB = `${process.env.HOME}/.local/share/opencode/opencode.db`;
const CONTEXT_DB = `${process.env.HOME}/.local/share/opencode/storage/plugin/magic-context/context.db`;

const args = process.argv.slice(2);
let sessionId = "";
let messageLimit = 50;
let scoreThreshold = 0.15;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--limit" && args[i + 1]) {
		messageLimit = Number.parseInt(args[i + 1], 10);
		i++;
	} else if (args[i] === "--threshold" && args[i + 1]) {
		scoreThreshold = Number.parseFloat(args[i + 1]);
		i++;
	} else if (!args[i].startsWith("--")) {
		sessionId = args[i];
	}
}

// ─── Stopwords ───────────────────────────────────────────

const STOPWORDS = new Set([
	// English
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "shall",
	"should", "may", "might", "must", "can", "could", "am",
	"i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
	"they", "them", "their", "its", "this", "that", "these", "those",
	"in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
	"into", "about", "between", "through", "after", "before", "during",
	"above", "below", "up", "down", "out", "off", "over", "under",
	"and", "but", "or", "nor", "not", "no", "so", "if", "then", "than",
	"too", "very", "just", "also", "here", "there", "when", "where",
	"how", "what", "which", "who", "whom", "why",
	"all", "each", "every", "both", "few", "more", "most", "other",
	"some", "such", "only", "own", "same", "still", "any",
	// Common agent/chat words
	"yes", "no", "ok", "okay", "sure", "please", "thanks", "thank",
	"let", "lets", "let's", "go", "check", "look", "see", "think",
	"know", "need", "want", "make", "get", "put", "take", "give",
	"use", "try", "run", "show", "tell", "ask", "say", "said",
	"now", "first", "also", "already", "actually", "right", "well",
	"like", "don't", "didn't", "doesn't", "isn't", "aren't", "won't",
	"can't", "couldn't", "shouldn't", "wouldn't", "haven't", "hasn't",
	"one", "two", "three", "new", "good", "bad", "big", "small",
	"thing", "things", "way", "much", "many", "something", "anything",
	"work", "working", "works", "done", "start", "started", "maybe",
	"instead", "because", "since", "while", "even", "though",
	"after", "before", "again", "back", "going", "gonna",
]);

// ─── Keyword extraction ──────────────────────────────────

function extractSearchTerms(text: string): string[] {
	// Remove markdown/code blocks
	const cleaned = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]+`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[{}[\]()=<>|;:,]/g, " ");

	const tokens: string[] = [];

	for (const raw of cleaned.split(/\s+/)) {
		const token = raw.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
		if (!token || token.length < 3) continue;

		const lower = token.toLowerCase();
		if (STOPWORDS.has(lower)) continue;

		// Keep technical-looking tokens (camelCase, snake_case, paths, dotted)
		const isTechnical =
			/[A-Z]/.test(token) && /[a-z]/.test(token) || // camelCase or PascalCase
			token.includes("_") ||                          // snake_case
			token.includes(".") ||                          // dotted names
			token.includes("/") ||                          // paths
			token.includes("-") ||                          // kebab-case
			/^\d/.test(token) === false && token === token.toUpperCase(); // ALLCAPS acronym

		// Keep if technical OR at least 4 chars (filters out noise)
		if (isTechnical || token.length >= 4) {
			tokens.push(lower);
		}
	}

	// Deduplicate preserving order
	return [...new Set(tokens)];
}

// ─── FTS search (memories + facts) ──────────────────────

interface SearchHit {
	source: "memory" | "fact";
	id: number;
	category: string;
	content: string;
	score: number;
}

function searchMemoriesFTS(db: Database, projectPath: string, query: string, limit: number): SearchHit[] {
	const sanitized = query.split(/\s+/).map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
	if (!sanitized.trim()) return [];

	try {
		const rows = db.prepare(`
			SELECT mf.memory_id, mf.rank, m.content, m.category
			FROM memory_fts mf
			JOIN memories m ON m.id = mf.memory_id
			WHERE memory_fts MATCH ? AND m.project_path = ? AND m.status = 'active'
			ORDER BY mf.rank
			LIMIT ?
		`).all(sanitized, projectPath, limit) as Array<{ memory_id: number; rank: number; content: string; category: string }>;

		return rows.map(r => ({
			source: "memory" as const,
			id: r.memory_id,
			category: r.category,
			content: r.content,
			score: Math.abs(r.rank), // FTS5 rank is negative, lower = better
		}));
	} catch {
		return [];
	}
}

function searchFactsFTS(db: Database, sessionId: string, query: string): SearchHit[] {
	const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
	if (terms.length === 0) return [];

	try {
		const rows = db.prepare(`
			SELECT id, category, content FROM session_facts WHERE session_id = ?
		`).all(sessionId) as Array<{ id: number; category: string; content: string }>;

		return rows
			.map(r => {
				const lower = r.content.toLowerCase() + " " + r.category.toLowerCase();
				const matchCount = terms.filter(t => lower.includes(t)).length;
				return {
					source: "fact" as const,
					id: r.id,
					category: r.category,
					content: r.content,
					score: matchCount / terms.length,
				};
			})
			.filter(r => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 10);
	} catch {
		return [];
	}
}

// ─── Read user messages from OpenCode DB ─────────────────

interface UserMessage {
	ordinal: number;
	id: string;
	text: string;
	time: number;
}

function readUserMessages(openDb: Database, sid: string, limit: number): UserMessage[] {
	const msgRows = openDb.prepare(`
		SELECT id, data FROM message 
		WHERE session_id = ? 
		ORDER BY time_created DESC 
		LIMIT ?
	`).all(sid, limit * 3) as Array<{ id: string; data: string }>;

	const results: UserMessage[] = [];
	let ordinal = msgRows.length;

	// Reverse to get chronological order for ordinal assignment
	for (const row of msgRows.reverse()) {
		try {
			const msg = JSON.parse(row.data);
			if (msg.role !== "user") {
				ordinal--;
				continue;
			}

			// Get text parts
			const partRows = openDb.prepare(`
				SELECT data FROM part WHERE message_id = ? ORDER BY id
			`).all(row.id) as Array<{ data: string }>;

			const textParts: string[] = [];
			for (const pr of partRows) {
				try {
					const part = JSON.parse(pr.data);
					if (part.type === "text" && typeof part.text === "string" && !part.ignored) {
						textParts.push(part.text);
					}
				} catch { /* skip */ }
			}

			const text = textParts.join("\n").trim();
			if (text) {
				results.push({ ordinal: ordinal--, id: row.id, text, time: msg.time?.created ?? 0 });
			} else {
				ordinal--;
			}
		} catch {
			ordinal--;
		}
	}

	return results.slice(-limit).reverse(); // newest first
}

// ─── Main ────────────────────────────────────────────────

async function main() {
	const openDb = new Database(OPENCODE_DB, { readonly: true });
	const ctxDb = new Database(CONTEXT_DB, { readonly: true });

	// Resolve session ID
	if (!sessionId) {
		const latest = openDb.prepare(`
			SELECT id FROM session ORDER BY time_created DESC LIMIT 1
		`).get() as { id: string } | null;
		if (!latest) { console.error("No sessions found"); process.exit(1); }
		sessionId = latest.id;
	}

	// Resolve project identity
	const proc = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], { stdout: "pipe" });
	const rootHash = new TextDecoder().decode(proc.stdout).trim().split("\n")[0] ?? "";
	const projectPath = rootHash ? `git:${rootHash}` : "";

	console.log(`Session: ${sessionId}`);
	console.log(`Project: ${projectPath}`);
	console.log(`Threshold: ${scoreThreshold}`);
	console.log(`Limit: ${messageLimit} user messages (newest first)\n`);

	const messages = readUserMessages(openDb, sessionId, messageLimit);
	console.log(`Found ${messages.length} user messages\n`);
	console.log("═".repeat(80));

	let wouldNudge = 0;
	let totalMessages = 0;
	let skippedShort = 0;

	for (const msg of messages) {
		totalMessages++;
		const preview = msg.text.length > 120 ? `${msg.text.slice(0, 120)}…` : msg.text;

		// Extract terms
		const terms = extractSearchTerms(msg.text);

		if (terms.length < 2) {
			skippedShort++;
			console.log(`\n[${totalMessages}] ${preview}`);
			console.log(`  Terms: ${terms.length === 0 ? "(none)" : terms.join(", ")}`);
			console.log("  → SKIP (too few terms)");
			continue;
		}

		// Build search query from top terms (max 6 to avoid noise)
		const searchQuery = terms.slice(0, 6).join(" ");

		// Search
		const memHits = searchMemoriesFTS(ctxDb, projectPath, searchQuery, 5);
		const factHits = searchFactsFTS(ctxDb, sessionId, searchQuery);

		const allHits = [...memHits, ...factHits].sort((a, b) => b.score - a.score);
		const topHit = allHits[0];
		const triggered = topHit && topHit.score >= scoreThreshold;

		console.log(`\n[${totalMessages}] ${preview}`);
		console.log(`  Terms: ${terms.join(", ")}`);
		console.log(`  Query: "${searchQuery}"`);

		if (allHits.length === 0) {
			console.log("  → No hits");
		} else {
			for (const hit of allHits.slice(0, 3)) {
				const contentPreview = hit.content.length > 80 ? `${hit.content.slice(0, 80)}…` : hit.content;
				const marker = hit.score >= scoreThreshold ? "✅" : "  ";
				console.log(`  ${marker} [${hit.source}] score=${hit.score.toFixed(3)} cat=${hit.category} "${contentPreview}"`);
			}

			if (triggered) {
				wouldNudge++;
				const suggestedQuery = terms.slice(0, 3).join(" ");
				console.log(`  → 💡 WOULD NUDGE: "Related context exists — consider ctx_search("${suggestedQuery}")"`);
			} else {
				console.log(`  → Below threshold (top=${topHit?.score.toFixed(3) ?? "n/a"})`);
			}
		}
	}

	console.log("\n" + "═".repeat(80));
	console.log(`\nSummary:`);
	console.log(`  Total user messages:  ${totalMessages}`);
	console.log(`  Skipped (too short):  ${skippedShort}`);
	console.log(`  Searchable:           ${totalMessages - skippedShort}`);
	console.log(`  Would nudge:          ${wouldNudge} (${((wouldNudge / Math.max(1, totalMessages - skippedShort)) * 100).toFixed(1)}%)`);
	console.log(`  Threshold:            ${scoreThreshold}`);

	openDb.close();
	ctxDb.close();
}

main().catch(console.error);
