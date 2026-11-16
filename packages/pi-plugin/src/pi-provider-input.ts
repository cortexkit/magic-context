/** Provider identity for serializers that omit these root bookkeeping fields. */
export function piProviderInput(message: unknown): unknown {
	if (!message || typeof message !== "object" || Array.isArray(message))
		return message;
	// Keep identically named nested tool arguments in provider identity.
	const descriptors = Object.getOwnPropertyDescriptors(message);
	delete descriptors.completedAt;
	delete descriptors.contextSnapshot;
	return Object.create(Object.getPrototypeOf(message), descriptors);
}
