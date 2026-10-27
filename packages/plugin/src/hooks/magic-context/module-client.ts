import { getDefaultSubcConnectionFile, SubcModuleTransport } from "./module-transport";

/** The calls a host lane makes on `ck-mc` through its subc route. */
export interface ModuleSessionClient {
    call(args: Parameters<SubcModuleTransport["call"]>[0]): Promise<unknown>;
    deleteSession?(sessionId: string, projectRoot: string): Promise<void>;
    closeSession?(sessionId: string): void;
}

/**
 * Build the subc-backed module client every host lane uses to reach `ck-mc`.
 *
 * Two adapters need the identical client: the OpenCode 1 server lane and the
 * OpenCode 2 setup lane. Building it in one place is what stops the two from
 * drifting — a method added for one host would otherwise silently be missing on
 * the other, and the difference would only show up as "Rust module status
 * unavailable" on whichever lane was forgotten.
 *
 * Constructing the transport is inert: it opens no connection until a call is
 * actually made, so a lane may build the client before it knows whether this
 * session will use it.
 */
export function createSubcModuleClient(options: {
    /** Configured `subc.connection_file`; the shared default is used when absent. */
    connectionFile?: string;
    /** Route root recorded on calls that need a bound project. */
    projectRoot: string;
}): ModuleSessionClient {
    const transport = new SubcModuleTransport(
        options.connectionFile ?? getDefaultSubcConnectionFile(),
    );
    return {
        call: (args) => transport.call(args),
        deleteSession: (sessionId, projectRoot) => transport.deleteSession(sessionId, projectRoot),
        closeSession: (sessionId) => transport.closeSession(sessionId),
    };
}
