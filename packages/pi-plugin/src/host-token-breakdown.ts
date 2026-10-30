import { measureHostToolDefinitions } from "@magic-context/core/hooks/magic-context/host-token-breakdown";

export function hostToolSchemaBytes(
	tools: readonly {
		name?: string;
		description?: string;
		parameters?: unknown;
	}[],
): string[] {
	return tools.map((tool) => {
		let parameters = "";
		try {
			parameters =
				tool.parameters == null
					? ""
					: typeof tool.parameters === "string"
						? tool.parameters
						: (JSON.stringify(tool.parameters) ?? "");
		} catch {
			parameters = "";
		}
		return `${tool.name ?? ""}\n${tool.description ?? ""}\n${parameters}`;
	});
}

export { measureHostToolDefinitions };
