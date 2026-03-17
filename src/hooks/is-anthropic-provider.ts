export function isAnthropicProvider(providerID: string): boolean {
    return providerID === "anthropic" || providerID === "google-vertex-anthropic";
}
