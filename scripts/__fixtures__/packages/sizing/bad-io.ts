// FIXTURE: deliberately violates SIZING-PURE-NO-IO. Not compiled, not shipped.
//
// Each line below is a different way to make sizing irreproducible: a file read,
// a database driver, a network call, a clock, or a source of randomness. Any one
// of them means the same intent can produce two different quantities, which is
// the failure the whole package is built to be incapable of.
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

export const decidedAt = Date.now();
export const stamped = new Date();
export const jitter = Math.random();
export const tuning = process.env['SIZING_MODE'];
export const elapsed = performance.now();
export async function quote(): Promise<unknown> {
  return fetch('https://api.coindcx.com/exchange/ticker');
}
export const unused = [readFileSync, Pool];
