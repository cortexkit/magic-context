export interface NormalizeSDKResponseOptions {
    preferResponseOnMissingData?: boolean;
}

// Audit note: `as TData` casts are intentional at this boundary. The OpenCode plugin SDK types
// external responses as `unknown`. Adding Zod validation here would require schema definitions
// for every SDK response shape, which changes with each OpenCode release. The fallback parameter
// provides safe degradation when shapes mismatch.
export function normalizeSDKResponse<TData>(
    response: unknown,
    fallback: TData,
    options?: NormalizeSDKResponseOptions,
): TData {
    if (response === null || response === undefined) {
        return fallback;
    }

    if (Array.isArray(response)) {
        return response as TData;
    }

    if (typeof response === "object" && "data" in response) {
        const data = (response as { data?: unknown }).data;
        if (data !== null && data !== undefined) {
            return data as TData;
        }

        if (options?.preferResponseOnMissingData === true) {
            return response as TData;
        }

        return fallback;
    }

    if (options?.preferResponseOnMissingData === true) {
        return response as TData;
    }

    return fallback;
}
