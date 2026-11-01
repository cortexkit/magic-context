import "./quiet-live-log";
import { computeProtectionWindow } from "../../../packages/plugin/src/features/magic-context/protection-window.ts"

// Mirror the canonical fixtures in protection-window.test.ts, retaining their labels and identities.
const tool = (tag_number: number, row_identity: string, tokenCount: number | null, kind = "tool") => ({ tag_number, row_identity, kind, tokenCount })
const range = (count: number, mass: number) => Array.from({ length: count }, (_, i) => tool(i + 1, `r${i + 1}`, mass))
const ties = [tool(7, "r7", 4000), tool(8, "r8", 4000), tool(9, "a", 10000), tool(9, "b", 10000), tool(10, "r10", 4000), tool(11, "r11", 4000), tool(12, "r12", 4000)]
const short = [tool(4, "r1", 500), tool(9, "r2", 500)]
const fixtures = [
  { label: "F1 exhausted history", rows: range(20, 250) },
  { label: "F2 single large read", rows: [...range(9, 2000), tool(10, "r10", 40000)] },
  { label: "F3 exact equality", rows: range(10, 4000) },
  { label: "F4 opposed tie ascending", rows: ties },
  { label: "F4 opposed tie descending", rows: [...ties].reverse() },
  { label: "F5 invisible mass", rows: [tool(1, "r1", 1000), tool(2, "r2", null), { ...tool(3, "r3", 2000), status: "dropped" }, { ...tool(4, "r4", 30000), status: "edit_marker" }] },
  { label: "F6 disjoint coordinate spaces", rows: [tool(1, "r1", 4000), tool(7, "r7", 4000), tool(8, "r8", 4000), tool(9, "r9", 4000), tool(10, "r10", 4000)] },
  { label: "F7 open invocation and boundary tie", rows: [tool(1, "r1", 500), tool(10, "10a", 500), tool(10, "10b", 500), tool(11, "m1", 2000, "message"), tool(11, "11_open", null), tool(11, "f1", 1000, "file"), tool(12, "12_mass", 20000)] },
  { label: "F8 empty", rows: [] },
  { label: "F8 non-tool only", rows: [tool(1, "m1", 500, "message"), tool(2, "m2", 500, "message"), tool(3, "f1", 1000, "file"), tool(4, "m3", 500, "message"), tool(5, "f2", 1000, "file"), tool(6, "m4", 500, "message")] },
  { label: "F9 two tools", rows: [tool(1, "m1", 100, "message"), short[0], tool(6, "m2", 200, "message"), short[1], tool(11, "f1", 300, "file")] },
  { label: "F9 one tool", rows: short.slice(0, 1) },
  { label: "F9S step 0", rows: [] },
  { label: "F9S step 1", rows: short.slice(0, 1) },
  { label: "F9S step 2", rows: short },
  { label: "F9S step 3", rows: [...short, ...Array.from({ length: 18 }, (_, i) => tool(i + 10, `r${i + 3}`, 250))] },
]

const cases = fixtures.map((fixture) => {
  const floor = 16000
  const result = computeProtectionWindow(fixture.rows, floor)
  const protectedRows = [...result.memberRows].map((row) => `${row.tag_number}:${row.row_identity}`).sort()
  const cutoffPredicateRows = fixture.rows.filter((row) => row.kind === "tool" && result.cutoff !== null && row.tag_number >= result.cutoff).map((row) => `${row.tag_number}:${row.row_identity}`).sort()
  if (JSON.stringify(protectedRows) !== JSON.stringify(cutoffPredicateRows)) throw new Error(`${fixture.label}: member rows differ from cutoff predicate`)
  return { ...fixture, floor, expectedCutoff: result.cutoff, expectedProtectedRows: protectedRows, expectedProtectedCount: result.status.protectedCount, expectedProtectedMass: result.status.protectedMass, cutoffPredicateRows }
})
await Bun.write(`${import.meta.dir}/protection-window-golden.json`, `${JSON.stringify({ schema: 1, cases }, null, 2)}\n`)
