import type { Database } from "../../../shared/sqlite";
import type { ReportedProfile } from "./lifecycle-gates";
import {
    buildTurnOneAuthorizationRequest,
    freezeTurnOneProfile,
    persistTurnOneAuthorization,
} from "./turn-two";
import { expandTurnTwoEntry, type TurnTwoEntry } from "./turn-two-allowlist";

export function authorizationFixture(
    profile: Pick<
        TurnTwoEntry,
        "lane" | "carrier" | "provider" | "modelId" | "variant" | "temperature" | "thinkingLevel"
    >,
    system: string,
    toolSurface: unknown = ["historian"],
    formatInstruction = "Combined historian format contract",
) {
    const request = buildTurnOneAuthorizationRequest(profile, {
        system,
        formatInstruction,
        toolSurface,
        checkToolSurface: [],
    });
    const rows = expandTurnTwoEntry(request.requestedIdentity);
    return {
        request,
        profile: rows[0]!,
        rows,
        /** Mirrors parseEnabledTurnOne's result.step and XML envelope. */
        turnOne(xml: string): string {
            return JSON.stringify({ result: { step: "turn_one", xml } });
        },
        checkProfile(systemHash: string): ReportedProfile {
            const row = rows.slice(1).find((candidate) => candidate.systemHash === systemHash);
            if (!row) throw new Error("Unknown check system in fixture");
            return { ...row };
        },
        persist(db: Database, stageKey: string, actual: ReportedProfile = rows[0]!) {
            persistTurnOneAuthorization(db, stageKey, request);
            freezeTurnOneProfile(db, stageKey, actual);
        },
    };
}
