import type { AcceptedAdvisory, AuditPolicy } from "./audit-production-input";
import {
	AuditInputError,
	httpsUrl,
	isPackageName,
	isRecord,
	requiredString,
} from "./audit-production-input";

export {
	AuditInputError,
	createProductionManifest,
	parsePolicy,
} from "./audit-production-input";

type Finding = {
	readonly id: string;
	readonly package: string;
	readonly severity: "high" | "critical";
	readonly title: string;
	readonly dependencyPath: string;
};

type AcceptedFinding = Finding & { readonly exception: AcceptedAdvisory };

type Evaluation = {
	readonly accepted: readonly AcceptedFinding[];
	readonly rejected: readonly Finding[];
};

export function resolvedDependencyPaths(
	output: string,
	artifact: string,
): readonly string[] {
	const stack: string[] = [];
	const paths = new Set<string>();
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const match = /^(\s*)(?:[├└]─\s)?(.+?)(?:\s+\(requires .+\))?$/.exec(line);
		if (match === null)
			throw new AuditInputError(`unrecognized bun pm why line: ${line}`);
		const indentation = match[1]?.length ?? 0;
		const node = match[2];
		if (node === undefined)
			throw new AuditInputError(`missing package in bun pm why line: ${line}`);
		const depth = indentation === 0 ? 0 : (indentation + 1) / 3;
		if (!Number.isInteger(depth))
			throw new AuditInputError(`unrecognized bun pm why indentation: ${line}`);
		stack[depth] = node;
		stack.length = depth + 1;
		const rootNode = node.replace(/^(?:optional|peer)\s+/, "");
		if (rootNode === artifact || rootNode.startsWith(`${artifact}@`)) {
			paths.add(stack.slice(0, -1).reverse().join(" > "));
		}
	}
	return [...paths];
}

function auditEntries(value: unknown): readonly [string, readonly unknown[]][] {
	if (!isRecord(value))
		throw new AuditInputError("bun audit JSON must be an object");
	return Object.entries(value).map(([packageName, advisories]) => {
		if (!isPackageName(packageName) || !Array.isArray(advisories)) {
			throw new AuditInputError("bun audit JSON contains an invalid package entry");
		}
		return [packageName, advisories] as const;
	});
}

export function auditPackageNames(value: unknown): readonly string[] {
	return auditEntries(value).map(([packageName]) => packageName);
}

function parseFinding(
	value: unknown,
	packageName: string,
	dependencyPath: string,
): Finding | undefined {
	if (!isRecord(value))
		throw new AuditInputError(`bun audit advisory for ${packageName} must be an object`);
	if (value.severity !== "high" && value.severity !== "critical") return undefined;
	const url = httpsUrl(
		requiredString(value.url, `${packageName} advisory URL`),
		`${packageName} advisory URL`,
	);
	const id = new URL(url).pathname.split("/").at(-1);
	if (id === undefined || id === "")
		throw new AuditInputError(`${packageName} advisory URL has no ID`);
	return {
		id,
		package: packageName,
		severity: value.severity,
		title: requiredString(value.title, `${packageName} advisory title`),
		dependencyPath,
	};
}

export function evaluateAudit(
	audit: unknown,
	policy: AuditPolicy,
	artifact: string,
	pathsByPackage: Readonly<Record<string, readonly string[]>>,
): Evaluation {
	const accepted: AcceptedFinding[] = [];
	const rejected: Finding[] = [];
	for (const [packageName, advisories] of auditEntries(audit)) {
		const resolvedPaths = pathsByPackage[packageName];
		const paths =
			resolvedPaths === undefined || resolvedPaths.length === 0
				? ["<unresolved>"]
				: resolvedPaths;
		for (const advisory of advisories) {
			for (const dependencyPath of paths) {
				const finding = parseFinding(advisory, packageName, dependencyPath);
				if (finding === undefined) continue;
				const exception = policy.acceptedAdvisories.find(
					(candidate) =>
						candidate.id === finding.id &&
						candidate.package === finding.package &&
						candidate.severity === finding.severity &&
						candidate.affectedArtifacts.includes(artifact) &&
						candidate.dependencyPath === finding.dependencyPath,
				);
				if (exception === undefined) rejected.push(finding);
				else accepted.push({ ...finding, exception });
			}
		}
	}
	return { accepted, rejected };
}
