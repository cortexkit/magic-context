const POLICY_SENTENCE_START =
    /(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b/i;
const ACTOR_POLICY =
    /\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b/i;
const BEHAVIORAL_WHEN_CLAUSE =
    /\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b/i;
const WORKFLOW_IMPERATIVE =
    /(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b/i;
const DECISION_AUTHORITY =
    /\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b/i;

/**
 * Recognize only explicit workflow language in PROJECT_RULES. The gate protects
 * process directives whose truth lives in team behavior, not repository code:
 * policy modals tied to people, behavioral "when" clauses, workflow imperatives,
 * and decision-authority statements. Declarative implementation claims such as
 * "binds use spread args" deliberately remain outside the gate and verifiable.
 */
export function isDirectiveShapedProjectRule(category: string, content: string): boolean {
    if (category !== "PROJECT_RULES") return false;
    const text = content.trim();
    if (!text) return false;
    return (
        POLICY_SENTENCE_START.test(text) ||
        ACTOR_POLICY.test(text) ||
        BEHAVIORAL_WHEN_CLAUSE.test(text) ||
        WORKFLOW_IMPERATIVE.test(text) ||
        DECISION_AUTHORITY.test(text)
    );
}
