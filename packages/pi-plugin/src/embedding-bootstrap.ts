import {
	type EmbeddingFeatures,
	registerProjectEmbeddingAndMaybeWipe,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { invalidateProject } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	handleUntrustedLoad,
	isConfigLoadUntrusted,
} from "@magic-context/core/plugin/embedding-bootstrap-helpers";
import { loadPiConfigDetailed } from "./config";

export async function ensureProjectRegisteredFromPiDirectory(
	directory: string,
	db: ContextDatabase,
): Promise<void> {
	const projectIdentity = resolveProjectIdentity(directory);
	invalidateProject(projectIdentity);

	const detailed = loadPiConfigDetailed({ cwd: directory });
	if (isConfigLoadUntrusted(detailed)) {
		handleUntrustedLoad(db, projectIdentity, directory, detailed);
		return;
	}

	const features: EmbeddingFeatures = {
		memoryEnabled: detailed.config.memory.enabled,
		gitCommitEnabled: detailed.config.experimental.git_commit_indexing.enabled,
	};
	registerProjectEmbeddingAndMaybeWipe(
		db,
		projectIdentity,
		detailed.config.embedding,
		features,
		directory,
	);
}
