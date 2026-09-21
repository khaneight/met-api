/**
 * Application errors carry an HTTP status and a stable machine-readable code.
 * Anything that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super(400, 'INVALID_REQUEST', 'Request validation failed', details);
  }
}

/** The Met API is throttling or blocking us; callers should back off. */
export class UpstreamRateLimitedError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    options?: ErrorOptions,
  ) {
    super(503, 'UPSTREAM_RATE_LIMITED', 'The Met API is rate limiting requests; try again shortly', undefined, options);
  }
}

/** The Met API failed, timed out, or returned something we could not parse. */
export class UpstreamError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(502, 'UPSTREAM_ERROR', message, undefined, options);
  }
}
