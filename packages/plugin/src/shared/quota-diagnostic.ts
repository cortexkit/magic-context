/** Only expose the generated quota deadline, not arbitrary provider output,
 * account identifiers, or private paths from the surrounding failure text. */
export function primaryQuotaDiagnostic(error: string | null | undefined): string | null {
    return (
        error?.match(
            /primary quota exhausted until \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
        )?.[0] ?? null
    );
}
