import assert from 'node:assert/strict'
import {
  isDialablePhoneNumber,
  normalizePhoneNumber,
  phoneTelHref,
} from '../src/phoneNumbers.ts'
import { normalizePhone } from '../server/runtime-config.mjs'

const cases = [
  ['+12025550143', '+12025550143'],
  ['+1 (202) 555-0143', '+12025550143'],
  ['(202) 555-0143', '+12025550143'],
  ['1-202-555-0143', '+12025550143'],
  ['4420 7946 0958', '+442079460958'],
  ['020 7946 0958', ''],
  ['+020 7946 0958', ''],
  ['+1 202 555 0143 ext 9', ''],
  ['202-555-0143 x9', ''],
  ['call 202-555-0143', ''],
  ['202+555+0143', ''],
  ['+1+2025550143', ''],
  ['1234567', ''],
  ['', ''],
]

for (const [input, expected] of cases) {
  assert.equal(normalizePhoneNumber(input), expected, `browser normalization: ${input}`)
  assert.equal(normalizePhone(input), expected, `server normalization: ${input}`)
  assert.equal(isDialablePhoneNumber(input), Boolean(expected), `dialability: ${input}`)
  assert.equal(phoneTelHref(input), expected ? `tel:${expected}` : '', `tel href: ${input}`)
}

console.log(JSON.stringify({ ok: true, cases: cases.length }, null, 2))
