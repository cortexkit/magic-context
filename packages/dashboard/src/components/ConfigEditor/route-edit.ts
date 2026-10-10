export function editRoute(
  value: Record<string, unknown>,
  previous: string,
  route: string,
  preset: unknown,
): Record<string, unknown> {
  const next = { ...value };
  delete next[previous];
  if (route) next[route] = preset;
  return next;
}
