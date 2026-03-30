export {
    buildCompartmentBlock,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    getSessionFacts,
    replaceAllCompartmentState,
    type SessionFact,
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
    getStrippedPlaceholderIds,
    loadPersistedUsage,
    setPersistedNudgePlacement,
    setPersistedStickyTurnReminder,
    setStrippedPlaceholderIds,
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
    queuePendingOp,
    removePendingOp,
} from "./storage-ops";
export {
    addSmartNote,
    deleteSmartNote,
    dismissSmartNote,
    getPendingSmartNotes,
    getReadySmartNotes,
    getSmartNotes,
    markSmartNoteChecked,
    markSmartNoteReady,
    type SmartNote,
    type SmartNoteStatus,
} from "./storage-smart-notes";
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
