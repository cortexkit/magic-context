// Type declarations for @opencode-ai/plugin/tui
// These types are not yet exported by the installed @opencode-ai/plugin package

declare module "@opencode-ai/plugin/tui" {
    import type {
        createOpencodeClient as createOpencodeClientV2,
        Event as TuiEvent,
        Message,
        Part,
        Provider,
        Config as SdkConfig,
    } from "@opencode-ai/sdk/v2";

    import type { CliRenderer, RGBA } from "@opentui/core";
    import type { JSX, SolidPlugin } from "@opentui/solid";

    type PluginOptions = Record<string, unknown>;

    export type { CliRenderer };

    export type TuiThemeCurrent = {
        readonly primary: RGBA;
        readonly secondary: RGBA;
        readonly accent: RGBA;
        readonly error: RGBA;
        readonly warning: RGBA;
        readonly success: RGBA;
        readonly info: RGBA;
        readonly text: RGBA;
        readonly textMuted: RGBA;
        readonly background: RGBA;
        readonly backgroundPanel: RGBA;
        readonly backgroundElement: RGBA;
        readonly backgroundMenu: RGBA;
        readonly border: RGBA;
        readonly borderActive: RGBA;
        readonly borderSubtle: RGBA;
        [key: string]: unknown;
    };

    export type TuiTheme = {
        readonly current: TuiThemeCurrent;
        has: (name: string) => boolean;
        set: (name: string) => boolean;
        mode: () => "dark" | "light";
        readonly ready: boolean;
    };

    export type TuiSlotMap = {
        app: Record<string, never>;
        home_logo: Record<string, never>;
        home_bottom: Record<string, never>;
        sidebar_title: {
            session_id: string;
            title: string;
            share_url?: string;
        };
        sidebar_content: {
            session_id: string;
        };
        sidebar_footer: {
            session_id: string;
        };
    };

    export type TuiSlotContext = {
        theme: TuiTheme;
    };

    export type TuiSlotPlugin = Omit<SolidPlugin<TuiSlotMap, TuiSlotContext>, "id"> & {
        id?: never;
    };

    export type TuiToast = {
        variant?: "info" | "success" | "warning" | "error";
        title?: string;
        message: string;
        duration?: number;
    };

    export type TuiDialogStack = {
        replace: (render: () => JSX.Element, onClose?: () => void) => void;
        clear: () => void;
        setSize: (size: "medium" | "large" | "xlarge") => void;
        readonly size: "medium" | "large" | "xlarge";
        readonly depth: number;
        readonly open: boolean;
    };

    export type TuiDialogAlertProps = {
        title: string;
        message: string;
        onConfirm?: () => void;
    };

    export type TuiDialogConfirmProps = {
        title: string;
        message: string;
        onConfirm?: () => void;
        onCancel?: () => void;
    };

    export type TuiDialogPromptProps = {
        title: string;
        description?: () => JSX.Element;
        placeholder?: string;
        value?: string;
        busy?: boolean;
        busyText?: string;
        onConfirm?: (value: string) => void;
        onCancel?: () => void;
    };

    export type TuiDialogSelectOption<Value = unknown> = {
        title: string;
        value: Value;
        description?: string;
        footer?: JSX.Element | string;
        category?: string;
        disabled?: boolean;
        onSelect?: () => void;
    };

    export type TuiDialogSelectProps<Value = unknown> = {
        title: string;
        placeholder?: string;
        options: TuiDialogSelectOption<Value>[];
        flat?: boolean;
        onMove?: (option: TuiDialogSelectOption<Value>) => void;
        onFilter?: (query: string) => void;
        onSelect?: (option: TuiDialogSelectOption<Value>) => void;
        skipFilter?: boolean;
        current?: Value;
    };

    export type TuiState = {
        readonly ready: boolean;
        readonly config: SdkConfig;
        readonly provider: ReadonlyArray<Provider>;
        readonly path: {
            state: string;
            config: string;
            worktree: string;
            directory: string;
        };
        session: {
            count: () => number;
            messages: (sessionID: string) => ReadonlyArray<Message>;
        };
        part: (messageID: string) => ReadonlyArray<Part>;
    };

    export type TuiEventBus = {
        on: <Type extends TuiEvent["type"]>(
            type: Type,
            handler: (event: Extract<TuiEvent, { type: Type }>) => void,
        ) => () => void;
    };

    export type TuiLifecycle = {
        readonly signal: AbortSignal;
        onDispose: (fn: () => void | Promise<void>) => () => void;
    };

    export type TuiPluginApi = {
        app: { readonly version: string };
        command: {
            register: (
                cb: () => Array<{
                    title: string;
                    value: string;
                    description?: string;
                    category?: string;
                    keybind?: string;
                    suggested?: boolean;
                    hidden?: boolean;
                    enabled?: boolean;
                    slash?: {
                        name: string;
                        aliases?: string[];
                    };
                    onSelect?: () => void;
                }>,
            ) => () => void;
            trigger: (value: string) => void;
        };
        route: {
            register: (
                routes: Array<{
                    name: string;
                    render: (input: { params?: Record<string, unknown> }) => JSX.Element;
                }>,
            ) => () => void;
            navigate: (name: string, params?: Record<string, unknown>) => void;
            readonly current:
                | { name: "home" }
                | { name: "session"; params: { sessionID: string; initialPrompt?: unknown } }
                | { name: string; params?: Record<string, unknown> };
        };
        ui: {
            DialogAlert: (props: TuiDialogAlertProps) => JSX.Element;
            DialogConfirm: (props: TuiDialogConfirmProps) => JSX.Element;
            DialogPrompt: (props: TuiDialogPromptProps) => JSX.Element;
            DialogSelect: <Value = unknown>(props: TuiDialogSelectProps<Value>) => JSX.Element;
            toast: (input: TuiToast) => void;
            dialog: TuiDialogStack;
        };
        state: TuiState;
        theme: TuiTheme;
        client: ReturnType<typeof createOpencodeClientV2>;
        event: TuiEventBus;
        renderer: CliRenderer;
        slots: {
            register: (plugin: TuiSlotPlugin) => string;
        };
        lifecycle: TuiLifecycle;
    };

    export type TuiPluginMeta = {
        state: "first" | "updated" | "same";
        id: string;
        source: "file" | "npm" | "internal";
        spec: string;
        target: string;
    };

    export type TuiPlugin = (
        api: TuiPluginApi,
        options: PluginOptions | undefined,
        meta: TuiPluginMeta,
    ) => Promise<void>;
}
