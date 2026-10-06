import { embeddedQuickJsWasmBase64 } from "./quickjs-wasm.macro" with { type: "macro" };

// Keep the bytecode in a dynamically imported chunk. Inlining it into the main
// plugin would make every host and subagent parse it even without smart notes.
export const quickJsWasmBase64 = embeddedQuickJsWasmBase64();
