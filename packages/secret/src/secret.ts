// The Secret wrapper — plan/phase-00 T00.7, from 07-api-key-security.md F6.
//
// A Secret cannot be printed, interpolated, serialised or inspected. There is
// exactly one way to get the value out, `expose()`, and a CI rule forbids
// calling it anywhere except apps/signer.
//
// This exists because leakage through logs, error trackers and crash dumps is
// the most common real-world cause of API key compromise — and because the
// competitor incident in 16-competitive-benchmark.md F1 started with keys
// reaching somewhere they should not have been.

export const REDACTED = '[redacted]';

const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Secret<T extends string = string> {
  readonly #value: T;
  /** A non-secret label for logs and error messages, e.g. 'api_secret'. */
  readonly label: string;

  private constructor(value: T, label: string) {
    if (typeof value !== 'string') {
      throw new TypeError(`Secret must wrap a string, received ${typeof value}`);
    }
    this.#value = value;
    this.label = label;
  }

  static of<V extends string>(value: V, label = 'secret'): Secret<V> {
    return new Secret(value, label);
  }

  /**
   * The only way out. Restricted to apps/signer by the SIGNER-ONLY-EXPOSE
   * CI rule — see scripts/ci-rules.mjs.
   */
  expose(): T {
    return this.#value;
  }

  /** Length is safe to know and useful for validation without revealing anything. */
  get length(): number {
    return this.#value.length;
  }

  /** Constant-time-ish equality, so a comparison cannot leak by timing. */
  equals(other: Secret<string>): boolean {
    const a = this.#value;
    const b = other.#value;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /** Interpolation and String(): `${secret}` yields the redaction marker. */
  toString(): string {
    return REDACTED;
  }

  /** JSON.stringify and anything that walks an object graph. */
  toJSON(): string {
    return REDACTED;
  }

  /** console.log and util.inspect. */
  [NODE_INSPECT](): string {
    return REDACTED;
  }

  /** Template literals and implicit string coercion. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }
}

export const isSecret = (v: unknown): v is Secret<string> => v instanceof Secret;
