/**
 * Ambient declaration for OMP's canonical coding-agent package.
 *
 * `dreamer/pi-session-api.ts` imports this specifier as a STRING LITERAL so the
 * OMP legacy-extension loader can rewrite it (that loader only records
 * references whose specifier parses as a StringLiteral), and the build keeps it
 * `--external` so it is resolved at runtime rather than bundled. It is
 * deliberately NOT a dependency: the shipped `omp` binary is a
 * `bun build --compile` executable whose host modules live inside the
 * executable, and adding a real devDependency here would pin a second,
 * divergent copy of the host API -- the exact drift this resolver exists to
 * avoid (see the header of dreamer/pi-session-api.ts). TypeScript can still
 * only accept the literal import against a declaration, so it is declared here.
 *
 * The members are the ones the resolver probes, and the ones the running host
 * actually exposes: loading the extension under `omp` and awaiting the bare
 * import yields `SessionManager=function parseSessionEntries=function
 * loadEntriesFromFile=function`. Same role as OMP's own
 * `src/extensibility/plugins/legacy-pi-virtual-modules.d.ts`.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export const SessionManager: {
		listAll(sessionDir?: string): unknown[] | Promise<unknown[]>;
	};
	export function loadEntriesFromFile(
		filePath: string,
	): unknown[] | Promise<unknown[]>;
	export function parseSessionEntries(content: string): unknown[];
}
