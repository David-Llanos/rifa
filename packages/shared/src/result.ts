/**
 * Discriminated union for success or typed error, used by all service interfaces.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/**
 * Validation error for a single input field. `constraint` is a stable machine-readable code
 * (for example "required", "length", "range", "currency"), and `params` carries the values a
 * localized message needs (for example `{ min: 10, max: 100000 }`).
 */
export interface FieldError {
  readonly field: string;
  readonly constraint: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type FieldErrors = readonly FieldError[];

export function fieldError(
  field: string,
  constraint: string,
  params?: Record<string, string | number>,
): FieldError {
  return params === undefined ? { field, constraint } : { field, constraint, params };
}
