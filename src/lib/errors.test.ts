import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DrevError,
  OwnershipError,
  RedactionError,
  RepoError,
  SessionError,
  ValidationError,
} from './errors.js';

describe('DrevError taxonomy', () => {
  const subclasses = [
    { Cls: ConfigError, code: 'CONFIG_ERROR', name: 'ConfigError' },
    { Cls: RepoError, code: 'REPO_ERROR', name: 'RepoError' },
    { Cls: SessionError, code: 'SESSION_ERROR', name: 'SessionError' },
    { Cls: ValidationError, code: 'VALIDATION_ERROR', name: 'ValidationError' },
    { Cls: RedactionError, code: 'REDACTION_ERROR', name: 'RedactionError' },
    { Cls: OwnershipError, code: 'OWNERSHIP_ERROR', name: 'OwnershipError' },
  ] as const;

  it('every subclass extends DrevError and Error', () => {
    for (const { Cls } of subclasses) {
      const err = new Cls('boom');
      expect(err).toBeInstanceOf(DrevError);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(Cls);
    }
  });

  it('exposes a stable static code matching the instance code', () => {
    for (const { Cls, code } of subclasses) {
      expect(Cls.code).toBe(code);
      const err = new Cls('msg');
      expect(err.code).toBe(code);
    }
  });

  it('sets name to the subclass constructor name', () => {
    for (const { Cls, name } of subclasses) {
      expect(new Cls('msg').name).toBe(name);
    }
  });

  it('preserves the cause chain', () => {
    const root = new Error('underlying');
    const wrapped = new RepoError('wrap', { cause: root });
    expect(wrapped.cause).toBe(root);
  });

  it('chains DrevError causes recursively', () => {
    const inner = new ConfigError('inner');
    const outer = new RepoError('outer', { cause: inner });
    expect(outer.cause).toBe(inner);
    const outerJson = outer.toJSON();
    expect(outerJson.cause).toEqual({
      name: 'ConfigError',
      code: 'CONFIG_ERROR',
      message: 'inner',
    });
  });

  it('serializes to JSON with name, code, message', () => {
    const err = new ValidationError('bad input');
    expect(err.toJSON()).toEqual({
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
      message: 'bad input',
    });
    // JSON.stringify uses toJSON automatically.
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
      message: 'bad input',
    });
  });

  it('serializes a plain Error cause to {name, message}', () => {
    const root = new TypeError('nope');
    const err = new SessionError('fail', { cause: root });
    expect(err.toJSON().cause).toEqual({ name: 'TypeError', message: 'nope' });
  });

  it('omits cause from JSON when none was provided', () => {
    const json = new ConfigError('x').toJSON();
    expect(json).not.toHaveProperty('cause');
  });

  it('keeps a usable stack trace', () => {
    const err = new OwnershipError('denied');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('OwnershipError');
  });
});
