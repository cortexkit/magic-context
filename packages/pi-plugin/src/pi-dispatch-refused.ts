/**
 * Pi and OMP swallow request-hook exceptions and retain the original payload.
 * Return a non-thenable replacement instead: awaiting it is safe, but every
 * serializer operation fails before transport. Never abort in the request hook:
 * OMP's abort race would discard the replacement and retain the raw request.
 */
export function piRefusedPayload(message: string): object {
	const fail = (): never => {
		throw new Error(message);
	};
	return new Proxy(Object.create(null), {
		get: (_target, key) => (key === "then" ? undefined : fail()),
		ownKeys: fail,
		getOwnPropertyDescriptor: fail,
		set: fail,
		has: fail,
		getPrototypeOf: fail,
	});
}
