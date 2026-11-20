/** A query whose text contains only `$n` placeholders; every value travels separately. */
export interface ParameterizedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Tagged template that turns interpolations into `$1, $2, ...` placeholders, so user input can never
 * change query structure: sql`SELECT * FROM t WHERE id = ${id}`.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): ParameterizedQuery {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  return { text, values };
}

/**
 * Guard for the data layer: query text must carry no string literals, comments or extra statements,
 * and every `$n` placeholder must have a value (parameterized queries only, Requirement 15.8).
 */
export function assertParameterized(text: string, values: readonly unknown[]): void {
  if (/'|"|--|\/\*|;\s*\S/.test(text)) {
    throw new Error("Query text must not embed literals, comments or multiple statements");
  }
  const used = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = used.length ? Math.max(...used) : 0;
  if (max !== values.length || used.some((n) => n < 1 || n > values.length)) {
    throw new Error("Placeholder count does not match the supplied values");
  }
}
