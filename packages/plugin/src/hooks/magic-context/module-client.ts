import { getDefaultSubcConnectionFile, SubcModuleTransport } from "./module-transport";
import type { RustModeModuleClient } from "./rust-mode-transform";

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
}): RustModeModuleClient {
    const transport = new SubcModuleTransport(
        options.connectionFile ?? getDefaultSubcConnectionFile(),
    );
    return {
        call: (args) => transport.call(args),
        stateSyncCapabilities: (args) => transport.stateSyncCapabilities(args),
        deleteSession: (sessionId, projectRoot) => transport.deleteSession(sessionId, projectRoot),
        closeSession: (sessionId) => transport.closeSession(sessionId),
        authorityStatus: (args) => transport.authorityStatus(args),
        authorityPrepare: (args) => transport.authorityPrepare(args),
        authoritySeed: (args) => transport.authoritySeed(args),
        authorityDrain: (args) => transport.authorityDrain(args),
        mirrorPull: (args) => transport.mirrorPull(args),
        markerStatus: (args) => transport.markerStatus(args),
        mirrorMemory: (args) => transport.mirrorMemory(args),
        memoryIdentityAck: (args) => transport.memoryIdentityAck(args),
        getCompartmentsAfter: async (sessionId, afterSequence) => {
            const response = await transport.call({
                sessionId,
                projectRoot: options.projectRoot,
                method: "session.status",
                body: {
                    method: "session.status",
                    v: 1,
                    session_id: sessionId,
                    include_compartments_after_seq: afterSequence,
                },
            });
            const value =
                response && typeof response === "object" && "result" in response
                    ? (response as { result?: unknown }).result
                    : response;
            const record = value && typeof value === "object" ? value : {};
            const compartments =
                "compartments" in record && Array.isArray(record.compartments)
                    ? record.compartments
                    : [];
            const maxSequence =
                "max_sequence" in record && typeof record.max_sequence === "number"
                    ? record.max_sequence
                    : afterSequence;
            const compartmentCount =
                "compartment_count" in record && typeof record.compartment_count === "number"
                    ? record.compartment_count
                    : undefined;
            const revertEpoch =
                "revert_epoch" in record && typeof record.revert_epoch === "number"
                    ? record.revert_epoch
                    : undefined;
            return {
                max_sequence: maxSequence,
                compartments,
                ...(compartmentCount !== undefined ? { compartment_count: compartmentCount } : {}),
                ...(revertEpoch !== undefined ? { revert_epoch: revertEpoch } : {}),
                ...("set_changed" in record && record.set_changed === true
                    ? { set_changed: true }
                    : {}),
            };
        },
    };
}
