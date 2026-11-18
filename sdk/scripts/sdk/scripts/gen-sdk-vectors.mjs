// Regenerates test/vectors/sdk-{2-of-2,2-of-3,3-of-3}.json: threshold transactions sealed by the
// TypeScript SDK, the mirror image of the rust-*.json vectors the Rust encoder produced. The Rust
// threshold tests decode these to prove the two implementations stay byte compatible, and the
// negative tests tamper with them to prove confidentiality and AEAD integrity. Deterministic
// keypairs and blockhash keep the plain transaction stable across runs; the sealed fragments are
// fresh randomness each run, which is fine: only the committed JSON is tested.
// Usage: npm run build && node scripts/gen-sdk-vectors.mjs
import { writeFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import { toBase58 } from '@acrux/contract'
import { seal, deriveHeader, headerBytes } from '../dist/index.js'

const payer = Keypair.fromSeed(new Uint8Array(32).fill(7))
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(9))
const blockhash = toBase58(new Uint8Array(32).fill(3))
const targetSlot = 100

const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100 }),
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 10000 }),
)
transaction.sign(payer)
const bytes = transaction.serialize()

const header = deriveHeader(bytes, targetSlot)
const headerSignature = ed25519.sign(headerBytes(header), payer.secretKey.slice(0, 32))

// Match the rust-*.json layout: sorted keys, two-space indent.
const sorted = value =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
      : value

for (const [n, t] of [[2, 2], [3, 2], [3, 3]]) {
  const receivers = Array.from({ length: n }, (_, i) => i + 1)
  const fragments = seal(bytes, header, headerSignature, t, receivers)
  const vector = {
    feePayer: payer.publicKey.toBase58(),
    recipient: recipient.publicKey.toBase58(),
    plain: { header, transaction: Buffer.from(bytes).toString('base64'), receivers },
    fragments,
  }
  const path = new URL(`../test/vectors/sdk-${t}-of-${n}.json`, import.meta.url)
  writeFileSync(path, JSON.stringify(sorted(vector), null, 2) + '\n')
  console.log(`wrote ${path.pathname}`)
}
