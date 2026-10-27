// Pinned to OMP 18.10.4, 18.12.3 and 18.12.6's prompts/steering/user-interjection.md.
// The host applies this after the context hook, to every steering user message.
export const PI_OMP_STEERING_TEMPLATE =
	"<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\n{{message}}\n";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// OMP's prompt.render runs prompt.format after interpolation, even on user text.
// Model its default formatting only: trailing whitespace, blank runs, XML closing
// lines and Markdown tables. Code fences disable the latter three operations.
function renderSteering(text: string): string {
	const lines = PI_OMP_STEERING_TEMPLATE.replace(
		"{{message}}",
		() => text,
	).split("\n");
	const result: string[] = [];
	let code = false;
	for (let index = 0; index < lines.length; index++) {
		let line = lines[index].trimEnd();
		// OMP scans spaces/tabs before choosing its Unicode trimming path. A
		// blanket trimStart would strip a leading CR and invent a code fence.
		let indent = 0;
		while (line.charCodeAt(indent) === 32 || line.charCodeAt(indent) === 9)
			indent++;
		if (line.charCodeAt(indent) >= 128)
			indent = line.length - line.trimStart().length;
		const start = line.slice(indent);
		if (start.startsWith("```") || start.startsWith("~~~")) {
			code = !code;
			result.push(line);
			continue;
		}
		if (code) {
			result.push(line);
			continue;
		}
		if (/^\|[-:\s|]+\|$/.test(start)) {
			const cells = start.split("|").filter((cell) => cell.trim());
			line =
				line.slice(0, line.length - start.length) +
				"|" +
				cells
					.map((cell) => {
						const value = cell.trim();
						return `${value.startsWith(":") ? ":" : ""}---${value.endsWith(":") ? ":" : ""}`;
					})
					.join("|") +
				"|";
		} else if (/^\|.*\|$/.test(start)) {
			line =
				line.slice(0, line.length - start.length) +
				start
					.split("|")
					.map((cell) => cell.trim())
					.join("|");
		}
		if (!line.trim()) {
			const next = lines[index + 1];
			if (next === undefined || !next.trim()) {
				while (result.at(-1) === "") result.pop();
				while (index + 1 < lines.length && !lines[index + 1].trim()) index++;
				continue;
			}
			if (!result.length || result.at(-1) === "") continue;
		}
		if (/^<\/[a-z_-]+>$/.test(start)) {
			while (result.at(-1) === "") result.pop();
		}
		result.push(line);
	}
	while (result.at(-1) === "") result.pop();
	return result.join("\n");
}

/** Model OMP's user wrapper for dispatch checks only; never rewrite served history. */
export function piOmpUserHistory(
	message: Record<string, unknown>,
): Record<string, unknown> {
	if (message.role !== "user" || message.steering !== true) return message;
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part) => object(part)?.type === "text")
						.map((part) => object(part)?.text)
						.join("\n")
				: "";
	if (!text.length) return message;
	const { steering: _steering, ...rest } = message;
	const wrapped = renderSteering(text);
	return {
		...rest,
		content:
			typeof content === "string"
				? wrapped
				: [
						{ type: "text", text: wrapped },
						...(Array.isArray(content)
							? content.filter((part) => object(part)?.type === "image")
							: []),
					],
	};
}
