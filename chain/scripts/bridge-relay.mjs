// The light client's relayer: takes a finalized cblock's proof from an Acrux gateway
// (`getCblockProof`) to acrux_bridge on Solana. It posts the cblock, sends the validators' signed
// votes through the ed25519 precompile until the cblock is certified, hands every validator set in
// its outbox on to the next epoch and pays out every withdrawal in it. Anyone may relay; the program
// checks everything.
// Usage: node scripts/bridge-relay.mjs --cblock <consensus slot> [--acrux http://127.0.0.1:4930] [--rpc http://127.0.0.1:4990] [--seed]
//   --seed first creates the bridge and seeds the cblock's epoch with the proof's validator set
//   (the bridge authority's step, once, for a local net).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import anchor from '@coral-xyz/anchor'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js'
import { chainDir, devKeypair } from './dev-keys.mjs'

export const EPOCH_SLOTS = 1536 // 96 windows of 16 slots, Acrux Net's epoch
const ED25519 = new PublicKey('Ed25519SigVerify111111111111111111111111111')
const VOTES_PER_TX = 4
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest()
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }

export function bridgeProgram(connection, wallet) {
  const idl = JSON.parse(readFileSync(join(chainDir, 'target/idl/acrux_bridge.json'), 'utf8'))
  return new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: 'confirmed' }))
}

/// The program's ProgramData account under the upgradeable loader, which `initialize` reads.
export const upgradeData = (programId) => PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0]

export const pdas = (programId) => {
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0]
  return {
    bridge: pda(Buffer.from('bridge')),
    set: (epoch) => pda(Buffer.from('set'), u64(epoch)),
    cblock: (hash) => pda(Buffer.from('cblock'), hash),
    released: (sequence) => pda(Buffer.from('released'), u64(sequence)),
  }
}

/// The bincode `Vote` a validator signs: validator, slot, Some(hash), kind (Notar 0, Finalize 4).
export const voteMessage = (validator, slot, hash, kind) => Buffer.concat([u64(validator), u64(slot), Buffer.from([1]), hash, Buffer.from(Uint32Array.of(kind === 'finalize' ? 4 : 0).buffer)])

/// One ed25519 precompile instruction verifying several signatures, all held in its own data.
export function ed25519Instruction(entries) {
  const head = 2 + entries.length * 14
  const offsets = Buffer.alloc(head)
  offsets[0] = entries.length
  const bodies = []
  let at = head
  entries.forEach(({ key, signature, message }, i) => {
    const o = 2 + i * 14
    const [keyAt, sigAt, msgAt] = [at, at + 32, at + 96]
    for (const [k, v] of [[0, sigAt], [2, 0xffff], [4, keyAt], [6, 0xffff], [8, msgAt], [10, message.length], [12, 0xffff]]) offsets.writeUInt16LE(v, o + k)
    bodies.push(key, signature, message)
    at += 96 + message.length
  })
  return new TransactionInstruction({ programId: ED25519, keys: [], data: Buffer.concat([offsets, ...bodies]) })
}

/// The outbox's Merkle proof for leaf `index`, as Acrux builds the root.
export function outboxProof(leaves, index) {
  let level = leaves.map((l) => sha256(l))
  const proof = []
  while (level.length > 1) {
    const sibling = index ^ 1
    if (sibling < level.length) proof.push({ left: sibling < index, hash: [...level[sibling]] })
    const next = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(level[i], level[i + 1]) : level[i])
    level = next
    index >>= 1
  }
  return proof
}

/// A bincode `OutboxEntry`: a validator set (its epoch and (key, stake) list) or a withdrawal.
export function decodeEntry(bytes) {
  if (bytes.readUInt32LE(0) === 1) {
    return {
      withdrawal: true,
      sequence: new anchor.BN(bytes.readBigUInt64LE(4).toString()),
      mint: new PublicKey(bytes.subarray(12, 44)),
      recipient: new PublicKey(bytes.subarray(44, 76)),
      amount: new anchor.BN(bytes.readBigUInt64LE(76).toString()),
    }
  }
  const epoch = bytes.readBigUInt64LE(4)
  const count = Number(bytes.readBigUInt64LE(12))
  const validators = []
  for (let i = 0; i < count; i++) {
    const o = 20 + i * 40
    validators.push({ key: new PublicKey(bytes.subarray(o, o + 32)), stake: new anchor.BN(bytes.readBigUInt64LE(o + 32).toString()) })
  }
  return { epoch: new anchor.BN(epoch.toString()), validators }
}

const send = (program, instructions) => program.provider.sendAndConfirm(new Transaction().add(...instructions), [])

/// Seeds `epoch` with the proof's validator set, creating the bridge first if it is not there.
export async function seed(program, proof, epoch) {
  const { bridge, set } = pdas(program.programId)
  const payer = program.provider.wallet.publicKey
  if (!(await program.provider.connection.getAccountInfo(bridge))) await program.methods.initialize(new anchor.BN(EPOCH_SLOTS)).accounts({ payer, programData: upgradeData(program.programId) }).rpc()
  if (await program.provider.connection.getAccountInfo(set(epoch))) return
  const validators = proof.validators.map((key, i) => ({ key: new PublicKey(key), stake: new anchor.BN(proof.stakes[i]) }))
  await program.methods.initValidatorSet(new anchor.BN(epoch), validators).accounts({ authority: payer }).rpc()
}

/// Relays one cblock's proof: post, attest until certified, hand its validator sets on, pay its
/// withdrawals.
export async function relay(program, proof) {
  const { cblock: cblockOf, set, released } = pdas(program.programId)
  const hash = Buffer.from(proof.hash, 'hex')
  const cblock = cblockOf(hash)
  const connection = program.provider.connection
  const payer = program.provider.wallet.publicKey
  const report = { slot: proof.consensusSlot, epoch: Math.floor((proof.consensusSlot * 4) / EPOCH_SLOTS), cblock: cblock.toBase58(), transactions: [] }
  if (!(await connection.getAccountInfo(cblock))) {
    report.transactions.push(await program.methods.postCblock([...hash], [...Buffer.from(proof.outboxRoot, 'hex')], Buffer.from(proof.preimage, 'base64')).accountsPartial({ payer, cblock }).rpc())
  }
  // Finalize votes first: 60% of the stake certifies, where Notar needs 80%.
  const votes = [...proof.votes].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'finalize' ? -1 : 1))
  for (let i = 0; i < votes.length && !(await program.account.cblock.fetch(cblock)).certified; i += VOTES_PER_TX) {
    const entries = votes.slice(i, i + VOTES_PER_TX).map((v) => ({
      key: new PublicKey(proof.validators[v.validator]).toBuffer(),
      signature: Buffer.from(v.signature, 'base64'),
      message: voteMessage(v.validator, proof.consensusSlot, hash, v.kind),
    }))
    const attest = await program.methods.attestCblock().accountsPartial({ cblock, set: set(report.epoch), instructions: SYSVAR_INSTRUCTIONS_PUBKEY }).instruction()
    report.transactions.push(await send(program, [ed25519Instruction(entries), attest]))
  }
  const state = await program.account.cblock.fetch(cblock)
  report.certified = state.certified
  report.finalizeBits = state.finalize
  report.notarBits = state.notar
  const leaves = proof.outbox.map((e) => Buffer.from(e, 'base64'))
  report.handedOn = []
  report.released = []
  for (const [index, leaf] of leaves.entries()) {
    const entry = decodeEntry(leaf)
    if (!state.certified || !entry) continue
    if (entry.withdrawal) {
      if (await connection.getAccountInfo(released(entry.sequence.toNumber()))) continue
      // The recipient's token account at the mint, made if it is missing, receives the payout.
      const tokenProgram = (await connection.getAccountInfo(entry.mint)).owner
      const destination = getAssociatedTokenAddressSync(entry.mint, entry.recipient, true, tokenProgram)
      const release = await program.methods.release(entry.sequence, entry.recipient, entry.amount, outboxProof(leaves, index))
        .accountsPartial({ payer, cblock, mint: entry.mint, destination, tokenProgram }).instruction()
      report.transactions.push(await send(program, [createAssociatedTokenAccountIdempotentInstruction(payer, destination, entry.recipient, entry.mint, tokenProgram), release]))
      report.released.push({ sequence: entry.sequence.toNumber(), recipient: entry.recipient.toBase58(), amount: entry.amount.toString() })
      continue
    }
    if (await connection.getAccountInfo(set(entry.epoch.toNumber()))) continue
    report.transactions.push(await program.methods.handOff(entry.epoch, entry.validators, outboxProof(leaves, index)).accountsPartial({ payer, cblock }).rpc())
    report.handedOn.push(entry.epoch.toNumber())
  }
  return report
}

export async function cblockProof(acrux, slot) {
  const body = await (await fetch(acrux, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getCblockProof', params: { consensusSlot: slot } }) })).json()
  if (body.error) throw new Error(`getCblockProof ${slot}: ${body.error.message}`)
  return body.result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
  const program = bridgeProgram(new Connection(arg('rpc', 'http://127.0.0.1:4990'), 'confirmed'), devKeypair('local-authority'))
  const proof = await cblockProof(arg('acrux', 'http://127.0.0.1:4930'), Number(arg('cblock')))
  if (process.argv.includes('--seed')) await seed(program, proof, Math.floor((proof.consensusSlot * 4) / EPOCH_SLOTS))
  console.log(JSON.stringify(await relay(program, proof)))
                             }
