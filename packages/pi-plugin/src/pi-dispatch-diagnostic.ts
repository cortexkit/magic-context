import { log as coreLog } from "@magic-context/core/shared/logger";
import {
	type PiPreparedStructure,
	piDispatchMismatchDiagnostic,
} from "./pi-dispatch-structure";

/** Keep each safe scalar in its own log slot so doctor issue reports retain it. */
export function logPiDispatchMismatch(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
	mismatch: string,
	log: (message: string) => void = coreLog,
): void {
	try {
		const foreign =
			/foreign rule=([1-4]) reason=(prepared-row|not-text-user|tool-pair|session-content|unreadable-branch|ambiguous-rewrite|search-limit|limit) count=(\d+) chars=(\d+)(?: gapPrepared=(\d+) gapWire=(\d+) gapChars=(\d+))?/u.exec(
				mismatch,
			);
		const rule = Number(foreign?.[1] ?? 0);
		const reason = foreign?.[2] ?? "none";
		const count = Number(foreign?.[3] ?? 0);
		const chars = Number(foreign?.[4] ?? 0);
		const gapPrepared = Number(foreign?.[5] ?? 0);
		const gapWire = Number(foreign?.[6] ?? 0);
		const gapChars = Number(foreign?.[7] ?? 0);
		const {
			row,
			firstInjectorRow,
			firstInjectorKind,
			expected: [e0, e1, e2],
			actual: [a0, a1, a2],
		} = piDispatchMismatchDiagnostic(payload, prepared, mismatch);
		log(
			`[magic-context][pi] ERROR dispatch structure refused: row=${row} firstInjectorRow=${firstInjectorRow} firstInjectorKind=${firstInjectorKind} foreignRule=${rule} foreignReason=${reason} foreignCount=${count} foreignChars=${chars} foreignGapPrepared=${gapPrepared} foreignGapWire=${gapWire} foreignGapChars=${gapChars} kinds[text=1,image=2,call=4,result=8,thinking=16,other=32] expectedPrevious role=${e0.role} parts=${e0.parts} kinds=${e0.kinds} chars=${e0.chars} injector=${e0.injector}; expectedCurrent role=${e1.role} parts=${e1.parts} kinds=${e1.kinds} chars=${e1.chars} injector=${e1.injector}; expectedNext role=${e2.role} parts=${e2.parts} kinds=${e2.kinds} chars=${e2.chars} injector=${e2.injector}; actualPrevious role=${a0.role} parts=${a0.parts} kinds=${a0.kinds} chars=${a0.chars} injector=${a0.injector}; actualCurrent role=${a1.role} parts=${a1.parts} kinds=${a1.kinds} chars=${a1.chars} injector=${a1.injector}; actualNext role=${a2.role} parts=${a2.parts} kinds=${a2.kinds} chars=${a2.chars} injector=${a2.injector}`,
		);
	} catch {
		// Logging cannot mask the original dispatch refusal.
	}
}
