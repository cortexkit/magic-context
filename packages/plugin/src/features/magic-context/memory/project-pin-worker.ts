import { parentPort } from "node:worker_threads";
import type { ProjectIdentityRecord } from "./project-identity-cache";
import { persistPinRequest } from "./project-pin-persistence";

export interface PinWriteRequest {
    destination: string;
    record: ProjectIdentityRecord;
    privateStorage: boolean;
    removeIfUnchanged?: string;
}

parentPort?.on("message", (request: PinWriteRequest) => {
    try {
        persistPinRequest(request);
        parentPort?.postMessage({ ok: true });
    } catch (error) {
        parentPort?.postMessage({ ok: false, error: String(error) });
    }
});
