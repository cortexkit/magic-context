import { readFileSync, unlinkSync } from "node:fs";
import { log } from "../../../shared/logger";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../../../shared/storage-permissions";
import type { PinWriteRequest } from "./project-pin-worker";

export function persistPinRequest(request: PinWriteRequest): void {
    if (request.removeIfUnchanged !== undefined) {
        try {
            if (readFileSync(request.destination, "utf8") === request.removeIfUnchanged) {
                unlinkSync(request.destination);
                log(`[magic-context] removed stale git worktree identity: ${request.destination}`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return;
    }
    setStoragePrivatePermissionEnforcement(request.privateStorage);
    writeStorageFileAtomicSync(request.destination, JSON.stringify(request.record));
}
