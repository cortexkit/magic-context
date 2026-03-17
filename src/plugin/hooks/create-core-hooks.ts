import type { MagicContextPluginConfig } from "../../config";
import type { PluginContext } from "../types";

import { createSessionHooks } from "./create-session-hooks";

export function createCoreHooks(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
}) {
    return createSessionHooks(args);
}
