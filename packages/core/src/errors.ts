/**
 * Errors the app means to show. `status` maps onto HTTP in the server; the message is safe to show
 * to the user (no server paths). Anything else is treated as an internal error.
 */
export class MemoriesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 500 | 501,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MemoriesError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new MemoriesError(message, 400, details);
export const notFound = (message: string, details?: Record<string, unknown>) => new MemoriesError(message, 404, details);
export const conflict = (message: string, details?: Record<string, unknown>) => new MemoriesError(message, 409, details);

/** Node-style system error code (ENOENT, EACCES …), if any. */
export function systemCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function isNotFound(error: unknown) {
  const code = systemCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  return error instanceof Error && /^Missing /.test(error.message);
}
