/** A private child diagnostic, not a host lifecycle event or provider message. */
export const SUBAGENT_STARTUP_ERROR_EVENT = "magic_context_startup_error";

export function readSubagentStartupError(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const value = event as { type?: unknown; error?: unknown };
	return value.type === SUBAGENT_STARTUP_ERROR_EVENT &&
		typeof value.error === "string" &&
		value.error.length > 0
		? value.error
		: undefined;
}

export async function reportSubagentStartupError(error: string): Promise<void> {
	// Drain the diagnostic before a request guard terminates the child. Stock Pi
	// can redirect extension stdout to stderr; the parent accepts either pipe.
	await new Promise<void>((resolve) => {
		process.stdout.write(
			`${JSON.stringify({ type: SUBAGENT_STARTUP_ERROR_EVENT, error })}\n`,
			() => resolve(),
		);
	});
}
