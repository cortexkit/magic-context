import type {
    AuthorityModuleClient,
    AuthorityStatus,
} from "../features/magic-context/context-authority";
import type {
    ClassifyModuleCallArgs,
    ClassifyModuleClient,
} from "../features/magic-context/dreamer/classify";
import type { RustModeModuleClient } from "../hooks/magic-context/rust-mode-transform";

export type DreamTimerModuleClient = ClassifyModuleClient &
    Pick<AuthorityModuleClient, "mirrorPull" | "markerStatus"> & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: AuthorityStatus | null }>;
    };

/**
 * Adapt the Rust transport without extracting methods from its class instance.
 * Subc transports read instance routing state, so every forwarded call must retain `this`.
 */
export function createDreamTimerModuleClient(
    moduleClient: RustModeModuleClient | undefined,
): DreamTimerModuleClient | undefined {
    if (!moduleClient) return undefined;
    return {
        authorityStatus: moduleClient.authorityStatus
            ? (args) => {
                  if (!moduleClient.authorityStatus) {
                      throw new Error("Rust module authority status route became unavailable");
                  }
                  return moduleClient.authorityStatus(args);
              }
            : undefined,
        call: (args: ClassifyModuleCallArgs) =>
            moduleClient.call(args as unknown as Parameters<RustModeModuleClient["call"]>[0]),
        mirrorPull: moduleClient.mirrorPull
            ? (args) => {
                  if (!moduleClient.mirrorPull) {
                      throw new Error("Rust module mirror route became unavailable");
                  }
                  return moduleClient.mirrorPull(args);
              }
            : undefined,
        markerStatus: moduleClient.markerStatus
            ? (args) => {
                  if (!moduleClient.markerStatus) {
                      throw new Error("Rust module marker status route became unavailable");
                  }
                  return moduleClient.markerStatus(args);
              }
            : undefined,
    };
}
