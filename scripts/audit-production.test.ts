import { describe, expect, test } from "bun:test";
import {
	createProductionManifest,
	evaluateAudit,
	parsePolicy,
	resolvedDependencyPaths,
} from "./audit-production-policy";

const artifact = "@example/artifact";
const advisoryId = "GHSA-aaaa-bbbb-cccc";
const dependencyPath = "parent@1.0.0 > vulnerable@1.0.0";

function policy(overrides: Record<string, unknown> = {}): unknown {
	return {
		auditLevel: "high",
		scope: "Published production dependencies",
		acceptedAdvisories: [
			{
				id: advisoryId,
				package: "vulnerable",
				severity: "high",
				affectedArtifacts: [artifact],
				dependencyPath,
				reachability: "The vulnerable parser is unreachable.",
				owner: "security@example.com",
				rationale: "Blocked on an upstream release.",
				expires: "2026-11-17",
				upstream: ["https://github.com/example/upstream/issues/1"],
				...overrides,
			},
		],
	};
}

const audit = {
	vulnerable: [
		{
			url: `https://github.com/advisories/${advisoryId}`,
			title: "Synthetic HIGH advisory",
			severity: "high",
		},
	],
};

describe("production audit policy", () => {
	test("accepts a finding only when ID, package, artifact, and resolved path match", () => {
		// Given
		const parsed = parsePolicy(policy(), "2026-08-19");

		// When
		const result = evaluateAudit(audit, parsed, artifact, {
			vulnerable: [dependencyPath],
		});

		// Then
		expect(result.accepted).toHaveLength(1);
		expect(result.rejected).toHaveLength(0);
	});

	test.each([
		["wrong artifact", "@example/other", dependencyPath],
		["wrong path", artifact, "other-parent@1.0.0 > vulnerable@1.0.0"],
	])("rejects an accepted advisory on the %s", (_case, actualArtifact, actualPath) => {
		// Given
		const parsed = parsePolicy(policy(), "2026-08-19");

		// When
		const result = evaluateAudit(audit, parsed, actualArtifact, {
			vulnerable: [actualPath],
		});

		// Then
		expect(result.rejected).toHaveLength(1);
	});

	test("rejects a new HIGH advisory", () => {
		// Given
		const parsed = parsePolicy(policy(), "2026-08-19");
		const newAudit = {
			other: [
				{
					url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
					title: "New HIGH advisory",
					severity: "high",
				},
			],
		};

		// When
		const result = evaluateAudit(newAudit, parsed, artifact, {
			other: ["other@1.0.0"],
		});

		// Then
		expect(result.rejected).toHaveLength(1);
	});

	test.each([
		"2026-99-99",
		"17-11-2026",
		"not-a-date",
	])("rejects malformed expiry %s", (expires) => {
		// Given / When / Then
		expect(() => parsePolicy(policy({ expires }), "2026-08-19")).toThrow();
	});

	test.each([
		"not-a-url",
		"http://github.com/example/upstream/issues/1",
		"https://",
	])("rejects malformed or insecure upstream URL %s", (upstream) => {
		// Given / When / Then
		expect(() =>
			parsePolicy(policy({ upstream: [upstream] }), "2026-08-19"),
		).toThrow();
	});
});

test("production manifest preserves every production dependency group", () => {
	// Given
	const source = {
		name: artifact,
		version: "1.0.0",
		dependencies: { runtime: "1.0.0" },
		optionalDependencies: { optional: "1.0.0" },
		peerDependencies: { peer: "1.0.0" },
		peerDependenciesMeta: { peer: { optional: false } },
		devDependencies: { devOnly: "1.0.0" },
	};

	// When
	const manifest = createProductionManifest(source);

	// Then
	expect(manifest).toEqual({
		name: artifact,
		version: "1.0.0",
		private: true,
		dependencies: source.dependencies,
		optionalDependencies: source.optionalDependencies,
		peerDependencies: source.peerDependencies,
		peerDependenciesMeta: source.peerDependenciesMeta,
	});
});

test("resolved paths reverse Bun why output and exclude the artifact root", () => {
	// Given
	const why = `vulnerable@1.0.0
  └─ parent@1.0.0 (requires ^1.0.0)
     └─ @example/artifact (requires ^1.0.0)
`;

	// When
	const paths = resolvedDependencyPaths(why, artifact);

	// Then
	expect(paths).toEqual([dependencyPath]);
});

test.each([
	"optional",
	"peer",
])("resolved paths recognize Bun's %s root marker", (relationship) => {
	// Given
	const why = `vulnerable@1.0.0
  └─ ${relationship} @example/artifact (requires 1.0.0)
`;

	// When
	const paths = resolvedDependencyPaths(why, artifact);

	// Then
	expect(paths).toEqual(["vulnerable@1.0.0"]);
});
