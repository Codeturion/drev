export abstract class DrevError extends Error {
  static readonly code: string = 'DREV_ERROR';
  readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
    this.code = (new.target as typeof DrevError).code;
    // Preserve prototype across transpilation targets that downlevel `extends Error`.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { name: string; code: string; message: string; cause?: unknown } {
    const out: { name: string; code: string; message: string; cause?: unknown } = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.cause !== undefined) {
      out.cause = serializeCause(this.cause);
    }
    return out;
  }
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof DrevError) return cause.toJSON();
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}

export class ConfigError extends DrevError {
  static override readonly code = 'CONFIG_ERROR';
}

export class RepoError extends DrevError {
  static override readonly code = 'REPO_ERROR';
}

export class SessionError extends DrevError {
  static override readonly code = 'SESSION_ERROR';
}

export class ValidationError extends DrevError {
  static override readonly code = 'VALIDATION_ERROR';
}

export class RedactionError extends DrevError {
  static override readonly code = 'REDACTION_ERROR';
}

export class OwnershipError extends DrevError {
  static override readonly code = 'OWNERSHIP_ERROR';
}
