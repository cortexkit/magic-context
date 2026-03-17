export {
    buildCompartmentBlock,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    getSessionFacts,
    replaceAllCompartmentState,
} from "./compartment-storage";
export {
    type ContextDatabase,
    closeDatabase,
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "./storage-db";
export {
    clearPersistedNudgePlacement,
    clearPersistedStickyTurnReminder,
    clearSession,
    getOrCreateSessionMeta,
    getPersistedNudgePlacement,
    getPersistedStickyTurnReminder,
    loadPersistedUsage,
    setPersistedNudgePlacement,
    setPersistedStickyTurnReminder,
    updateSessionMeta,
} from "./storage-meta";
export {
    addSessionNote,
    clearSessionNotes,
    getSessionNotes,
    replaceAllSessionNotes,
    type SessionNote,
} from "./storage-notes";
export {
    clearPendingOps,
    getPendingOps,
    hasPendingOps,
    queuePendingOp,
    removePendingOp,
} from "./storage-ops";
export {
    getSourceContents,
    replaceSourceContent,
    saveSourceContent,
} from "./storage-source";
export {
    getTagById,
    getTagsBySession,
    getTopNBySize,
    insertTag,
    updateTagMessageId,
    updateTagStatus,
} from "./storage-tags";
