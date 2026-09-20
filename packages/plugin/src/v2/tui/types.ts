import type { SidebarSnapshot } from "../../shared/rpc-types";

export interface V2TuiLocation {
    readonly directory: string;
}

export interface V2TuiRoute {
    readonly type: string;
    readonly sessionID?: string;
}

export interface V2TuiContext {
    readonly location?: V2TuiLocation;
    readonly renderer: { requestRender(): void };
    readonly data: {
        readonly listen: (handler: (event: { details: unknown }) => void) => () => void;
        readonly location: { default(): V2TuiLocation };
    };
    readonly keymap: {
        readonly layer: (
            input: () => {
                readonly mode?: string;
                readonly commands: ReadonlyArray<{
                    readonly id: string;
                    readonly title: string;
                    readonly group: string;
                    readonly palette: true;
                    readonly slash: { readonly name: string; readonly arguments?: true };
                    readonly run: (input?: string) => void | Promise<void>;
                }>;
            },
        ) => void;
    };
    readonly storage: {
        readonly memory: <Value extends object>(
            key: string,
            options: { readonly initial: Value },
        ) => readonly [Value, (mutation: (draft: Value) => void) => void];
    };
    readonly ui: {
        readonly router: { current(): V2TuiRoute };
        readonly slot: (claim: V2SlotClaim) => () => void;
        readonly toast: {
            show(options: {
                readonly title?: string;
                readonly message: string;
                readonly variant?: "info" | "success" | "warning" | "error";
                readonly duration?: number;
            }): void;
        };
        readonly dialog: {
            alert(options: { readonly title: string; readonly message: string }): Promise<void>;
            confirm(options: {
                readonly title: string;
                readonly message: string;
                readonly label?: { readonly confirm?: string; readonly cancel?: string };
            }): Promise<boolean | undefined>;
        };
    };
}

/**
 * A slot claim's `render` runs inside the host's component tree; `app` is the
 * always-mounted root slot, which is where `keymap.layer()` can be called from
 * when plugin `setup()` runs outside the keymap provider (see index.ts).
 */
export type V2SlotClaim =
    | {
          readonly append: "sidebar.content";
          readonly render: (input: { readonly sessionID: string }) => unknown;
      }
    | {
          readonly append: "app";
          readonly render: (input: Readonly<Record<string, never>>) => unknown;
      };

/** The layer object `context.keymap.layer()` accepts, derived from the context type. */
export type V2KeymapLayer = ReturnType<Parameters<V2TuiContext["keymap"]["layer"]>[0]>;

export interface V2SidebarState {
    snapshots: Record<string, SidebarSnapshot | undefined>;
}
