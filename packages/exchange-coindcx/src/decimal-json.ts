// Decimal-safe JSON — plan/phase-01 T01.4.
//
// `JSON.parse` destroys precision before you can intervene: by the time a
// reviver sees `min_quantity`, `0.00001` is already a double, and
// `max_quantity_market: 122.6936997` has already been rounded to whatever the
// nearest representable double is. A reviver cannot undo that, because the
// original digits are gone.
//
// So numbers are never converted. This parser returns every numeric literal as
// the exact string the venue sent, which is what `packages/money` wants as
// input anyway. Strings, booleans, null, objects and arrays behave normally.
//
// Sources: 05-coindcx-websockets.md (values arrive as decimal strings OR as
// JSON numbers in exponent form such as `3.1e-7`), DATA-MODEL.md (never convert
// numeric to number), DECISIONS.md D01.

export class JsonParseError extends Error {
  override readonly name = 'JsonParseError';
}

/** A parsed value where every number is the exact literal text. */
export type DecimalJson =
  | string
  | boolean
  | null
  | DecimalJson[]
  | { [key: string]: DecimalJson };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

class Reader {
  private i = 0;
  constructor(private readonly s: string) {}

  private fail(what: string): never {
    const near = this.s.slice(Math.max(0, this.i - 20), this.i + 20);
    throw new JsonParseError(`${what} at offset ${this.i} near: ${near}`);
  }

  private skip(): void {
    while (this.i < this.s.length && WHITESPACE.has(this.s[this.i] as string)) this.i += 1;
  }

  private peek(): string {
    if (this.i >= this.s.length) this.fail('unexpected end of input');
    return this.s[this.i] as string;
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected ${ch}`);
    this.i += 1;
  }

  parseTop(): DecimalJson {
    this.skip();
    const v = this.parseValue();
    this.skip();
    if (this.i !== this.s.length) this.fail('trailing content after JSON value');
    return v;
  }

  private parseValue(): DecimalJson {
    this.skip();
    const c = this.peek();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') return this.parseString();
    if (c === 't') return this.parseLiteral('true', true);
    if (c === 'f') return this.parseLiteral('false', false);
    if (c === 'n') return this.parseLiteral('null', null);
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumberAsString();
    return this.fail(`unexpected character ${c}`);
  }

  private parseLiteral<T extends boolean | null>(word: string, value: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return value;
    }
    return this.fail(`expected ${word}`);
  }

  /** The whole point: return the literal, unparsed. */
  private parseNumberAsString(): string {
    const start = this.i;
    if (this.peek() === '-') this.i += 1;
    while (this.i < this.s.length && /[0-9]/.test(this.s[this.i] as string)) this.i += 1;
    if (this.s[this.i] === '.') {
      this.i += 1;
      while (this.i < this.s.length && /[0-9]/.test(this.s[this.i] as string)) this.i += 1;
    }
    const e = this.s[this.i];
    if (e === 'e' || e === 'E') {
      this.i += 1;
      const sign = this.s[this.i];
      if (sign === '+' || sign === '-') this.i += 1;
      while (this.i < this.s.length && /[0-9]/.test(this.s[this.i] as string)) this.i += 1;
    }
    const text = this.s.slice(start, this.i);
    if (text === '' || text === '-') this.fail('malformed number');
    return text;
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.peek();
      this.i += 1;
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const esc = this.peek();
      this.i += 1;
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('malformed unicode escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.i += 4;
          break;
        }
        default: this.fail(`unknown escape \\${esc}`);
      }
    }
  }

  private parseArray(): DecimalJson[] {
    this.expect('[');
    const out: DecimalJson[] = [];
    this.skip();
    if (this.peek() === ']') { this.i += 1; return out; }
    for (;;) {
      out.push(this.parseValue());
      this.skip();
      const c = this.peek();
      this.i += 1;
      if (c === ']') return out;
      if (c !== ',') this.fail('expected , or ] in array');
    }
  }

  private parseObject(): { [key: string]: DecimalJson } {
    this.expect('{');
    const out: { [key: string]: DecimalJson } = {};
    this.skip();
    if (this.peek() === '}') { this.i += 1; return out; }
    for (;;) {
      this.skip();
      const key = this.parseString();
      this.skip();
      this.expect(':');
      out[key] = this.parseValue();
      this.skip();
      const c = this.peek();
      this.i += 1;
      if (c === '}') return out;
      if (c !== ',') this.fail('expected , or } in object');
    }
  }
}

/** Parse JSON with every number preserved as its exact literal string. */
export function parseDecimalJson(text: string): DecimalJson {
  if (typeof text !== 'string') throw new JsonParseError('input must be a string');
  return new Reader(text).parseTop();
}

/** Read a required string-or-number field as an exact string. */
export function requireScalar(obj: { [key: string]: DecimalJson }, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new JsonParseError(`field ${key} is ${v === undefined ? 'missing' : typeof v}, expected a scalar`);
  }
  return v;
}

/** Read an optional field. Absent and null both yield null. */
export function optionalScalar(obj: { [key: string]: DecimalJson }, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new JsonParseError(`field ${key} is ${typeof v}, expected a scalar or null`);
  return v;
}
