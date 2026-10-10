import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export type PiToolWireSchema = (tool: {
	name: string;
	description: string;
	parameters: unknown;
}) => unknown;

let resolver: Promise<PiToolWireSchema | undefined> | undefined;

/** Oh My Pi exposes schemas as functions that validate tool arguments, not
 * zero-argument schema factories. Its toolWireSchema extracts the provider's
 * JSON Schema and applies dialect/additionalProperties rules; counting that
 * exact representation avoids omitting tool bytes from the request fit bound. */
export function loadPiToolWireSchema(): Promise<PiToolWireSchema | undefined> {
	if (resolver) return resolver;
	resolver = (async () => {
		const specifier = "@oh-my-pi/pi-ai/utils/schema/wire";
		for (const base of [process.argv[1], import.meta.url]) {
			if (!base || (!base.startsWith("file:") && !isAbsolute(base))) continue;
			try {
				const path = import.meta.resolve(
					specifier,
					base.startsWith("file:") ? base : pathToFileURL(base).href,
				);
				const host = await import(path);
				if (typeof host.toolWireSchema === "function")
					return host.toolWireSchema;
			} catch {
				// Ordinary Pi schemas are already JSON objects. Without the host's
				// converter, callable schemas cannot establish a complete fit bound.
			}
		}
	})();
	return resolver;
}
