export type AcceptedAdvisory = {
	readonly id: string;
	readonly package: string;
	readonly severity: "high" | "critical";
	readonly affectedArtifacts: readonly string[];
	readonly dependencyPath: string;
	readonly reachability: string;
	readonly owner: string;
	readonly rationale: string;
	readonly expires: string;
	readonly upstream: readonly string[];
};

export type AuditPolicy = {
	readonly auditLevel: "high";
	readonly scope: string;
	readonly acceptedAdvisories: readonly AcceptedAdvisory[];
};

export type ProductionManifest = {
	readonly name: string;
	readonly version: string;
	readonly private: true;
	readonly [key: string]: unknown;
};

export class AuditInputError extends Error {}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		value.trim() !== value ||
		value.length === 0
	) {
		throw new AuditInputError(`${field} must be a non-empty trimmed string`);
	}
	return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new AuditInputError(`${field} must be a non-empty string array`);
	}
	return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

export function isPackageName(value: string): boolean {
	return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(value);
}

function parseResolvedNode(value: string, field: string): string {
	const separator = value.lastIndexOf("@");
	const packageName = value.slice(0, separator);
	const version = value.slice(separator + 1);
	if (
		separator < 1 ||
		!isPackageName(packageName) ||
		!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
	) {
		throw new AuditInputError(`${field} must contain exact package@version nodes`);
	}
	return packageName;
}

function isoDate(value: unknown, field: string): string {
	const date = requiredString(value, field);
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		Number.isNaN(parsed.valueOf()) ||
		parsed.toISOString().slice(0, 10) !== date
	) {
		throw new AuditInputError(`${field} must be a real YYYY-MM-DD date`);
	}
	return date;
}

export function httpsUrl(value: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error) {
		if (error instanceof TypeError)
			throw new AuditInputError(`${field} must be a valid HTTPS URL`);
		throw error;
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.hostname === ""
	) {
		throw new AuditInputError(`${field} must be a credential-free HTTPS URL`);
	}
	return value;
}

function parseAcceptedAdvisory(
	value: unknown,
	index: number,
	today: string,
): AcceptedAdvisory {
	if (!isRecord(value))
		throw new AuditInputError(`acceptedAdvisories[${index}] must be an object`);
	const field = (name: string): string => `acceptedAdvisories[${index}].${name}`;
	const id = requiredString(value.id, field("id"));
	if (
		!/^(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d{4,})$/i.test(id)
	) {
		throw new AuditInputError(`${field("id")} must be a GHSA or CVE ID`);
	}
	const packageName = requiredString(value.package, field("package"));
	if (!isPackageName(packageName))
		throw new AuditInputError(`${field("package")} is invalid`);
	if (value.severity !== "high" && value.severity !== "critical") {
		throw new AuditInputError(`${field("severity")} must be high or critical`);
	}
	const affectedArtifacts = stringArray(value.affectedArtifacts, field("affectedArtifacts"));
	if (affectedArtifacts.some((artifact) => !isPackageName(artifact))) {
		throw new AuditInputError(
			`${field("affectedArtifacts")} contains an invalid package name`,
		);
	}
	const dependencyPath = requiredString(value.dependencyPath, field("dependencyPath"));
	const pathPackages = dependencyPath
		.split(" > ")
		.map((node, nodeIndex) =>
			parseResolvedNode(node, `${field("dependencyPath")}[${nodeIndex}]`),
		);
	if (pathPackages.at(-1) !== packageName) {
		throw new AuditInputError(
			`${field("dependencyPath")} must end with ${packageName}@version`,
		);
	}
	const expires = isoDate(value.expires, field("expires"));
	if (expires <= today) throw new AuditInputError(`${id} acceptance expired on ${expires}`);
	const upstream = stringArray(value.upstream, field("upstream")).map((url, urlIndex) =>
		httpsUrl(url, `${field("upstream")}[${urlIndex}]`),
	);
	return {
		id,
		package: packageName,
		severity: value.severity,
		affectedArtifacts,
		dependencyPath,
		reachability: requiredString(value.reachability, field("reachability")),
		owner: requiredString(value.owner, field("owner")),
		rationale: requiredString(value.rationale, field("rationale")),
		expires,
		upstream,
	};
}

export function parsePolicy(value: unknown, today: string): AuditPolicy {
	if (!isRecord(value))
		throw new AuditInputError("production audit policy must be an object");
	if (value.auditLevel !== "high")
		throw new AuditInputError("production audit policy auditLevel must be high");
	if (!Array.isArray(value.acceptedAdvisories)) {
		throw new AuditInputError(
			"production audit policy acceptedAdvisories must be an array",
		);
	}
	isoDate(today, "current date");
	return {
		auditLevel: "high",
		scope: requiredString(value.scope, "production audit policy scope"),
		acceptedAdvisories: value.acceptedAdvisories.map((entry, index) =>
			parseAcceptedAdvisory(entry, index, today),
		),
	};
}

function dependencyGroup(
	value: unknown,
	field: string,
): Readonly<Record<string, unknown>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new AuditInputError(`${field} must be an object`);
	return value;
}

export function createProductionManifest(value: unknown): ProductionManifest {
	if (!isRecord(value))
		throw new AuditInputError("package manifest must be an object");
	const manifest: Record<string, unknown> & ProductionManifest = {
		name: requiredString(value.name, "package name"),
		version: requiredString(value.version, "package version"),
		private: true,
	};
	for (const group of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
	] as const) {
		const dependencies = dependencyGroup(value[group], group);
		if (dependencies !== undefined) manifest[group] = dependencies;
	}
	return manifest;
}
