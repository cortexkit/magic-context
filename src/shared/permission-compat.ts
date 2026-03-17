export type PermissionValue = "ask" | "allow" | "deny";

export interface PermissionFormat {
    permission: Record<string, PermissionValue>;
}

export function createAgentToolAllowlist(allowTools: string[]): PermissionFormat {
    return {
        permission: {
            "*": "deny",
            ...Object.fromEntries(allowTools.map((tool) => [tool, "allow" as const])),
        },
    };
}
