// The TypeScript-sealed vectors (scripts/gen-sdk-vectors.mjs): the reverse direction of
// seal.test.mjs, plus the confidentiality and integrity properties the threshold path claims.
// The Rust threshold tests decode these same files; a change here that breaks byte
// compatibility fails on both sides.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { fromBase58, fromBase64, FragmentSubmission } from '@acrux/contract'
import { open, deriveHeader, headerBytes } from '../dist/index.js'

const vector = name => JSON.parse(readFileSync(new URL(`./vectors/${name}.json`, import.meta.url), 'utf8'))
const subsets = (items, size) => size === 0 ? [[]] : items.flatMap((item, i) => subsets(items.slice(i + 1), size - 1).map(rest => [item, ...rest]))

// Returns a copy of the fragment with one byte of its ciphertext shard flipped.
// The public header is untouched, so a failure can only come from AEAD authentication.
const tamperShard = fragment => {
  const envelope = fromBase64(fragment.fragment)
  envelope[20] ^= 1 // past the 17-byte prefix, inside the shard
  return { ...fragment, fragment: Buffer.from(envelope).toString('base64') }
}
// Same idea for the Shamir key share: one flipped share byte must yield a wrong key.
const tamperShare = fragment => {
  const share = fromBase64(fragment.keyShare)
  share[10] ^= 1
  return { ...fragment, keyShare: Buffer.from(share).toString('base64') }
}

for (const [n, t] of [[2, 2], [3, 2], [3, 3]]) {
  const sdk = vector(`sdk-${t}-of-${n}`)
  const bytes = fromBase64(sdk.plain.transaction)

  test(`sdk ${t} of ${n}: the header derives from the bytes and its signature verifies`, () => {
    const header = deriveHeader(bytes, sdk.plain.header.targetSlot)
    assert.deepEqual(header, sdk.plain.header)
    assert.ok(ed25519.verify(fromBase58(sdk.fragments[0].headerSignature), headerBytes(header), fromBase58(header.feePayer)))
  })

  test(`sdk ${t} of ${n}: every fragment matches the contract, and every t of them open`, () => {
    assert.equal(sdk.fragments.length, n)
    for (const fragment of sdk.fragments) FragmentSubmission.parse(fragment)
    for (const chosen of subsets(sdk.fragments, t)) {
      assert.deepEqual(open(chosen), bytes)
      assert.deepEqual(open(chosen.toReversed()), bytes)
    }
  })

  test(`sdk ${t} of ${n}: fewer than t fragments never open (confidentiality)`, () => {
    for (const chosen of subsets(sdk.fragments, t - 1)) assert.throws(() => open(chosen))
  })

  test(`sdk ${t} of ${n}: a tampered shard or key share fails AEAD authentication (integrity)`, () => {
    const chosen = subsets(sdk.fragments, t)[0]
    assert.throws(() => open(chosen.map((f, i) => (i === 0 ? tamperShard(f) : f))))
    assert.throws(() => open(chosen.map((f, i) => (i === 0 ? tamperShare(f) : f))))
  })

  test(`sdk ${t} of ${n}: a tampered header breaks the AEAD associated data`, () => {
    const chosen = subsets(sdk.fragments, t)[0]
    const header = sdk.plain.header
    assert.throws(() => open(chosen.map(f => ({ ...f, header: { ...header, priorityFeePerCu: '101' } }))))
  })
}
