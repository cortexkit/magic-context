-- Provider state follows the same migration and writer discipline as engine state.
-- Keep every project/harness coordinate of the runner's opaque session key.
CREATE TABLE IF NOT EXISTS mc_provider_sessions_v1 (
    project_root TEXT NOT NULL,
    session TEXT NOT NULL,
    harness TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (project_root, session, harness)
);

-- Catalog admission can precede a provider call, when the tool route has no
-- caller-harness field yet. It is copied into the resolved conversation record.
CREATE TABLE IF NOT EXISTS mc_provider_catalogs_v1 (
    project_root TEXT NOT NULL,
    session TEXT NOT NULL,
    catalog TEXT NOT NULL,
    PRIMARY KEY (project_root, session)
);
