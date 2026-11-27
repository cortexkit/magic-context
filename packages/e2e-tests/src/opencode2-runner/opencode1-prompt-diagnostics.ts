import type { ChildProcess } from "node:child_process";

type ChildState = Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;

function processAlive({ pid, exitCode, signalCode }: ChildState): boolean | "unknown" {
	if (!pid || exitCode !== null || signalCode !== null) return false;
	try {
		// A prompt's HTTP connection can reset before Node reports the host's exit.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown";
	}
}

export function describeOpenCode1Host(
	host: string,
	child: ChildState,
	stdout: string,
	stderr: string,
): string {
	return [
		`${host}: pid=${child.pid ?? "none"} alive=${processAlive(child)} exitCode=${child.exitCode} signal=${child.signalCode}`,
		`stdout:\n${stdout || "(empty)"}`,
		`stderr:\n${stderr || "(empty)"}`,
	].join("\n");
}

export async function withOpenCode1PromptDiagnostics<T>(
	prompt: () => Promise<T>,
	diagnostics: () => string,
): Promise<T> {
	try {
		return await prompt();
	} catch (error) {
		try {
			console.error(`OpenCode 1 prompt request failed:\n${diagnostics()}`);
		} catch (diagnosticsError) {
			console.error("Could not collect OpenCode 1 prompt diagnostics:", diagnosticsError);
		}
		throw error;
	}
}
