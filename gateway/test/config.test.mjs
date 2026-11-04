// Formato de MAILGW_ENC_KEYS: errores claros, sin mostrar nunca la clave.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseKeys } from '../src/config.mjs';

const raw = crypto.randomBytes(32);
const b64 = raw.toString('base64');

test('acepta el formato y tolera comillas y espacios', () => {
  for (const v of [`k1:${b64}`, ` k1:${b64}\n`, `"k1:${b64}"`, `'k1:${b64}'`, `k2:${b64}, k1:${b64}`]) {
    assert.equal(parseKeys(v).current[1].length, 32, v);
  }
});

test('acepta también hexadecimal y base64 URL-safe, y decodifican a la misma clave', () => {
  for (const v of [raw.toString('hex'), raw.toString('base64url'), b64.replace(/=+$/, '')]) {
    assert.ok(parseKeys(`k1:${v}`).current[1].equals(raw), v);
  }
});

test('cada error dice qué falta y no muestra la clave', () => {
  const cases = [
    [b64, /le falta el identificador/],
    [`:${b64}`, /le falta el identificador/],
    [`MAILGW_ENC_KEYS=k1:${b64}`, /identificador inválido/],
    ['k1:corta', /hay 5 caracteres/],
    [`k1:${b64.slice(0, 20)}`, /hay 20 caracteres/],
    [`k1:${crypto.randomBytes(16).toString('hex')}`, /no es de 32 bytes/],
    [`k1:${b64.slice(0, 30)} ${b64.slice(30)}`, /no es de 32 bytes/],
    ['', /Falta MAILGW_ENC_KEYS/],
  ];
  for (const [v, re] of cases) {
    assert.throws(() => parseKeys(v), (e) => re.test(e.message) && !e.message.includes(b64.slice(0, 12)), v);
  }
});
