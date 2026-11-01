import { statSync } from "node:fs";
import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
} from "@magic-context/core/config/migrate-config-location";
import {
	type EmbeddingFeatures,
	registerProjectEmbedding,
	registerProjectShadowEmbedding,
	unregisterProjectEmbedding,
	unregisterProjectShadowEmbedding,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { preflightLocalEmbeddingPooling } from "@magic-context/core/features/magic-context/memory/local-embedding-pooling";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { drainProjectEmbeddingIdentityMaintenance } from "@magic-context/core/features/magic-context/project-embedding-registry";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	handleUntrustedLoad,
	isConfigLoadUntrusted,
} from "@magic-context/core/plugin/embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "@magic-context/core/plugin/embedding-routing";
import { log } from "@magic-context/core/shared/logger";

import { loadPiConfigDetailed } from "./config";

interface RegistrationFingerprint {
	paths: string[];
	fingerprint: string;
}

const registrationFingerprintsByDatabase = new WeakMap<
	object,
	Map<string, RegistrationFingerprint>
>();
const registeredIdentitiesByDatabase = new WeakMap<object, Set<string>>();

function configCandidatePaths(
	directory: string,
	loadedPaths: readonly string[],
): string[] {
	const projectBase = cortexKitProjectConfigBasePath(directory);
	const userBase = cortexKitUserConfigBasePath();
	return [
		`${projectBase}.jsonc`,
		`${projectBase}.json`,
		`${userBase}.jsonc`,
		`${userBase}.json`,
		...loadedPaths,
	].filter((path, index, paths) => paths.indexOf(path) === index);
}

function configFingerprint(paths: readonly string[]): string {
	return paths
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${path}:${stat.size}:${stat.mtimeMs}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("|");
}

export function unregisterPiProjectEmbeddings(db: ContextDatabase): void {
	for (const identity of registeredIdentitiesByDatabase.get(db) ?? [])
		unregisterProjectEmbedding(identity);
	registeredIdentitiesByDatabase.delete(db);
	registrationFingerprintsByDatabase.get(db)?.clear();
}

export async function ensureProjectRegisteredFromPiDirectory(
	directory: string,
	db: ContextDatabase,
	options: { preflightLocalPooling?: boolean } = {},
): Promise<void> {
	const detailed = loadPiConfigDetailed({ cwd: directory });
	const projectIdentity = resolveProjectIdentityForSession(
		directory,
		detailed.config.allow_home_project,
	);
	if (!projectIdentity) return;
	let registrationFingerprints = registrationFingerprintsByDatabase.get(db);
	if (!registrationFingerprints) {
		registrationFingerprints = new Map();
		registrationFingerprintsByDatabase.set(db, registrationFingerprints);
	}
	const cached = registrationFingerprints.get(projectIdentity);
	// Pooling metadata can become available without a configuration change.
	if (
		!options.preflightLocalPooling &&
		cached &&
		configFingerprint(cached.paths) === cached.fingerprint
	) {
		// Config caching must not cache away resumable database maintenance.
		await drainProjectEmbeddingIdentityMaintenance(db, projectIdentity);
		return;
	}

	if (isConfigLoadUntrusted(detailed)) {
		handleUntrustedLoad(db, projectIdentity, directory, detailed);
		return;
	}

	const routing = await resolveEmbeddingRouting({
		config: detailed.config,
		projectRoot: directory,
		session: `bootstrap:${projectIdentity}`,
	});
	for (const warning of routing.warnings) {
		log(`[magic-context] ${warning}`);
	}

	const features: EmbeddingFeatures = {
		memoryEnabled: detailed.config.memory.enabled,
		gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
	};
	if (options.preflightLocalPooling && routing.primary.provider === "local") {
		await preflightLocalEmbeddingPooling(
			routing.primary.model ?? "Xenova/all-MiniLM-L6-v2",
		);
	}
	let registered = registeredIdentitiesByDatabase.get(db);
	if (!registered) {
		registered = new Set();
		registeredIdentitiesByDatabase.set(db, registered);
	}
	registered.add(projectIdentity);
	registerProjectEmbedding(
		db,
		projectIdentity,
		routing.primary,
		features,
		directory,
	);
	if (routing.shadow) {
		registerProjectShadowEmbedding(
			db,
			projectIdentity,
			routing.shadow,
			directory,
		);
	} else {
		unregisterProjectShadowEmbedding(projectIdentity);
	}
	// Only failed daemon discovery can recover without a configuration change.
	const configuredProvider = detailed.config.embedding.provider;
	const canDiscover =
		Boolean(detailed.config.subc) &&
		(configuredProvider === "synapse"
			? Boolean(detailed.config.embedding.fallback_provider)
			: configuredProvider !== "off" &&
				detailed.config.shadow_embedding?.enabled === true);
	const discoveryFailed =
		canDiscover &&
		(configuredProvider === "synapse"
			? routing.primary.provider !== "synapse"
			: routing.shadow === null);
	if (!discoveryFailed) {
		const fingerprintPaths = configCandidatePaths(
			directory,
			detailed.loadedFromPaths,
		);
		registrationFingerprints.set(projectIdentity, {
			paths: fingerprintPaths,
			fingerprint: configFingerprint(fingerprintPaths),
		});
	} else {
		registrationFingerprints.delete(projectIdentity);
	}
}
