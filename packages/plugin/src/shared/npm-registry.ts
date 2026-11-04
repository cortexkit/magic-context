export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/** Match the registry environment inherited by npm and the host plugin installer. */
export function resolveNpmRegistryUrl(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.npm_config_registry?.trim() || env.NPM_CONFIG_REGISTRY?.trim();
    return (configured || NPM_REGISTRY_URL).replace(/\/+$/, "");
}
