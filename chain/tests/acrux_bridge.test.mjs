// acrux_bridge on the local validator: deposits lock tokens in the mint's vault and are recorded
// in sequence for Acrux to credit, and the light client certifies cblocks signed by Acrux's
// validators and hands their set on. Run through tests/run.mjs.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import anchor from '@coral-xyz/anchor'
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  createMint, getAccount, getMintLen, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { chainDir, devKeypair } from '../scripts/dev-keys.mjs'
import { RPC_URL } from '../scripts/registry.mjs'
import { EPOCH_SLOTS, ed25519Instruction, outboxProof, pdas, upgradeData, voteMessage } from '../scripts/bridge-relay.mjs'
import { createAssociatedTokenAccountIdempotent } from '@solana/spl-token'

const idl = JSON.parse(readFileSync(join(chainDir, 'target/idl/acrux_bridge.json'), 'utf8'))
const connection = new Connection(RPC_URL, 'confirmed')
const authority = devKeypair('local-authority')
const depositor = Keypair.generate()
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(depositor), { commitment: 'confirmed' }))
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0]
const bridge = pda(Buffer.from('bridge'))
const vaultOf = (mint) => pda(Buffer.from('vault'), mint.toBuffer())
const recordOf = (sequence) => pda(Buffer.from('deposit'), new anchor.BN(sequence).toArrayLike(Buffer, 'le', 8))
const recipient = Keypair.generate().publicKey // an Acrux address
let mint, source

const deposit = (amount, { mintKey = mint, from = source, tokenProgram = TOKEN_PROGRAM_ID, sequence } = {}) =>
  program.methods.deposit(new anchor.BN(amount.toString()), recipient).accounts({
    depositor: depositor.publicKey, mint: mintKey, source: from, record: recordOf(sequence), tokenProgram,
  }).rpc()

before(async () => {
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: depositor.publicKey, lamports: 10 * LAMPORTS_PER_SOL }),
  ), [authority])
  mint = await createMint(connection, depositor, depositor.publicKey, null, 6)
  source = (await getOrCreateAssociatedTokenAccount(connection, depositor, mint, depositor.publicKey)).address
  await mintTo(connection, depositor, mint, source, depositor, 10_000_000_000n)
})

test('initialize: the bridge starts at deposit 0, once', async () => {
  // The depositor is not the program's upgrade authority: rejected.
  await assert.rejects(program.methods.initialize(new anchor.BN(EPOCH_SLOTS)).accounts({ payer: depositor.publicKey, programData: upgradeData(program.programId) }).rpc(), /NotUpgradeAuthority/)
  await program.methods.initialize(new anchor.BN(EPOCH_SLOTS)).accounts({ payer: authority.publicKey, programData: upgradeData(program.programId) }).signers([authority]).rpc()
  assert.equal((await program.account.bridge.fetch(bridge)).deposits.toNumber(), 0)
  await assert.rejects(program.methods.initialize(new anchor.BN(EPOCH_SLOTS)).accounts({ payer: authority.publicKey, programData: upgradeData(program.programId) }).signers([authority]).rpc())
})

test('deposit: tokens lock in the mint\'s vault and each deposit is recorded in sequence', async () => {
  await deposit(1_000_000_000n, { sequence: 0 })
  await deposit(500_000_000n, { sequence: 1 })
  const vault = await getAccount(connection, vaultOf(mint))
  assert.equal(vault.amount, 1_500_000_000n)
  assert.equal(vault.owner.toBase58(), vaultOf(mint).toBase58())
  assert.equal((await getAccount(connection, source)).amount, 8_500_000_000n)
  const first = await program.account.depositRecord.fetch(recordOf(0))
  assert.deepEqual(
    [first.sequence.toNumber(), first.depositor.toBase58(), first.recipient.toBase58(), first.mint.toBase58(), first.amount.toString()],
    [0, depositor.publicKey.toBase58(), recipient.toBase58(), mint.toBase58(), '1000000000'],
  )
  assert.ok(first.slot.toNumber() > 0)
  assert.equal((await program.account.depositRecord.fetch(recordOf(1))).amount.toString(), '500000000')
  assert.equal((await program.account.bridge.fetch(bridge)).deposits.toNumber(), 2)
})

test('deposit: a Token-2022 mint with a transfer fee records what the vault received', async () => {
  const mint22 = Keypair.generate()
  const space = getMintLen([ExtensionType.TransferFeeConfig])
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: depositor.publicKey, newAccountPubkey: mint22.publicKey, space, lamports: await connection.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferFeeConfigInstruction(mint22.publicKey, depositor.publicKey, depositor.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint22.publicKey, 6, depositor.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [depositor, mint22])
  const from = (await getOrCreateAssociatedTokenAccount(connection, depositor, mint22.publicKey, depositor.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
  await mintTo(connection, depositor, mint22.publicKey, from, depositor, 1_000_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID)
  await deposit(100_000_000n, { mintKey: mint22.publicKey, from, tokenProgram: TOKEN_2022_PROGRAM_ID, sequence: 2 })
  // A 1% fee on 100 tokens is withheld in the vault's account: the deposit is 99.
  assert.equal((await program.account.depositRecord.fetch(recordOf(2))).amount.toString(), '99000000')
  assert.equal((await getAccount(connection, vaultOf(mint22.publicKey), 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 99_000_000n)
})

test('deposit: nothing, or someone else\'s tokens, is refused', async () => {
  await assert.rejects(deposit(0n, { sequence: 3 }), (err) => err.error?.errorCode?.code === 'ZeroAmount')
  const other = Keypair.generate()
  const theirs = (await getOrCreateAssociatedTokenAccount(connection, depositor, mint, other.publicKey)).address
  await mintTo(connection, depositor, mint, theirs, depositor, 1_000_000n)
  await assert.rejects(deposit(1_000_000n, { from: theirs, sequence: 3 }))
  assert.equal((await program.account.bridge.fetch(bridge)).deposits.toNumber(), 3)
})

// The light client, with three validators staking 40, 30 and 30.
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest()
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const validators = [40, 30, 30].map((stake) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { key: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'), privateKey, stake }
})
const asSet = (list) => list.map((v) => ({ key: new PublicKey(v.key), stake: new anchor.BN(v.stake) }))
// bincode OutboxEntry::ValidatorSet for `epoch`.
const setEntry = (epoch, list) => Buffer.concat([Buffer.alloc(4), u64(epoch), u64(list.length), ...list.flatMap((v) => [v.key, u64(v.stake)])])
const { set: setOf, cblock: cblockOf } = pdas(program.programId)
const slot = 7 // a cblock of epoch 0
const outbox = [setEntry(1, validators), Buffer.from('another entry')]
const root = sha256(sha256(outbox[0]), sha256(outbox[1]))
const preimage = Buffer.concat([u64(slot), Buffer.from('the rest of the cblock')])
const hash = sha256(preimage, root)
const vote = (v, kind, { at = slot, on = hash } = {}) => {
  const message = voteMessage(v, at, on, kind)
  return { key: validators[v].key, signature: sign(null, message, validators[v].privateKey), message }
}
const attest = async (votes, on = hash) => {
  const ix = await program.methods.attestCblock().accountsPartial({ cblock: cblockOf(on), set: setOf(0), instructions: SYSVAR_INSTRUCTIONS_PUBKEY }).instruction()
  return program.provider.sendAndConfirm(new Transaction().add(ed25519Instruction(votes), ix), [])
}
const handOff = (epoch, list, proof) => program.methods.handOff(new anchor.BN(epoch), asSet(list), proof).accountsPartial({ payer: depositor.publicKey, cblock: cblockOf(hash) }).rpc()

test('light client: only the authority seeds a validator set', async () => {
  const stranger = Keypair.generate()
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: depositor.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL })), [depositor])
  await assert.rejects(program.methods.initValidatorSet(new anchor.BN(0), asSet(validators)).accounts({ authority: stranger.publicKey }).signers([stranger]).rpc())
  await program.methods.initValidatorSet(new anchor.BN(0), asSet(validators)).accounts({ authority: authority.publicKey }).signers([authority]).rpc()
  assert.equal((await program.account.validatorSet.fetch(setOf(0))).total.toNumber(), 100)
  // Seeded once: the authority is renounced and cannot seed another epoch.
  await assert.rejects(program.methods.initValidatorSet(new anchor.BN(5), asSet(validators)).accounts({ authority: authority.publicKey }).signers([authority]).rpc())
})

test('light client: a cblock posts only with the preimage and root of its hash', async () => {
  const post = (h, r, p) => program.methods.postCblock([...h], [...r], p).accountsPartial({ payer: depositor.publicKey, cblock: cblockOf(h) }).rpc()
  await assert.rejects(post(hash, Buffer.alloc(32), preimage), (err) => err.error?.errorCode?.code === 'BadPreimage')
  await post(hash, root, preimage)
  const cblock = await program.account.cblock.fetch(cblockOf(hash))
  assert.deepEqual([cblock.slot.toNumber(), cblock.epoch.toNumber(), cblock.certified], [slot, 0, false])
})

test("light client: votes that are not a validator's, or not on this cblock, are refused", async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const message = voteMessage(0, slot, hash, 'finalize')
  const outsider = { key: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'), signature: sign(null, message, privateKey), message }
  await assert.rejects(attest([outsider]), (err) => /0x1774/.test(String(err)))
  await assert.rejects(attest([vote(0, 'finalize', { at: slot + 1 })]), (err) => /0x1774/.test(String(err)))
  await assert.rejects(attest([vote(0, 'finalize', { on: Buffer.alloc(32, 1) })]), (err) => /0x1774/.test(String(err)))
})

test('light client: 60% of the stake in Finalize votes certifies, and hands the next set on', async () => {
  await attest([vote(0, 'finalize'), vote(1, 'notar')])
  assert.equal((await program.account.cblock.fetch(cblockOf(hash))).certified, false)
  await assert.rejects(handOff(1, validators, outboxProof(outbox, 0)), (err) => err.error?.errorCode?.code === 'NotCertified')
  await attest([vote(1, 'finalize')])
  const cblock = await program.account.cblock.fetch(cblockOf(hash))
  assert.deepEqual([cblock.certified, cblock.finalize, cblock.notar], [true, 0b011, 0b010])
  // A set that is not the one in the outbox, or for another epoch, is refused.
  const changed = validators.map((v, i) => ({ ...v, stake: i === 0 ? 90 : v.stake }))
  await assert.rejects(handOff(1, changed, outboxProof(outbox, 0)), (err) => err.error?.errorCode?.code === 'BadProof')
  await assert.rejects(handOff(2, validators, outboxProof(outbox, 0)), (err) => err.error?.errorCode?.code === 'NotCertified')
  await handOff(1, validators, outboxProof(outbox, 0))
  const next = await program.account.validatorSet.fetch(setOf(1))
  assert.deepEqual([next.epoch.toNumber(), next.total.toNumber(), next.validators.length], [1, 100, 3])
})

// A withdrawal burned on Acrux, in the outbox of another cblock of epoch 0.
const payee = Keypair.generate().publicKey
const withdrawalEntry = (sequence, amount, to = payee) => Buffer.concat([Buffer.from([1, 0, 0, 0]), u64(sequence), mint.toBuffer(), to.toBuffer(), u64(amount)])
const releasing = () => {
  const outbox2 = [setEntry(1, validators), withdrawalEntry(5, 400_000_000)]
  const preimage2 = Buffer.concat([u64(slot + 4), Buffer.from('a later cblock')])
  const root2 = sha256(sha256(outbox2[0]), sha256(outbox2[1]))
  return { outbox2, preimage2, root2, hash2: sha256(preimage2, root2) }
}
const release = async (hash2, outbox2, { sequence = 5, amount = 400_000_000, to = payee } = {}) => {
  const destination = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, to, { commitment: 'confirmed' })
  return program.methods.release(new anchor.BN(sequence), to, new anchor.BN(amount), outboxProof(outbox2, 1))
    .accountsPartial({ payer: depositor.publicKey, cblock: cblockOf(hash2), mint, destination, tokenProgram: TOKEN_PROGRAM_ID }).rpc()
}

test('release: a withdrawal in a certified cblock is paid from the vault, once', async () => {
  const { outbox2, preimage2, root2, hash2 } = releasing()
  await program.methods.postCblock([...hash2], [...root2], preimage2).accountsPartial({ payer: depositor.publicKey, cblock: cblockOf(hash2) }).rpc()
  await assert.rejects(release(hash2, outbox2), (err) => err.error?.errorCode?.code === 'NotCertified')
  const signed = (v) => { const message = voteMessage(v, slot + 4, hash2, 'finalize'); return { key: validators[v].key, signature: sign(null, message, validators[v].privateKey), message } }
  await attest([signed(0), signed(1)], hash2)
  // Another amount, sequence or recipient is not in the outbox.
  await assert.rejects(release(hash2, outbox2, { amount: 500_000_000 }), (err) => err.error?.errorCode?.code === 'BadProof')
  await assert.rejects(release(hash2, outbox2, { sequence: 6 }), (err) => err.error?.errorCode?.code === 'BadProof')
  const vaultBefore = (await getAccount(connection, vaultOf(mint))).amount
  await release(hash2, outbox2)
  const destination = await createAssociatedTokenAccountIdempotent(connection, depositor, mint, payee, { commitment: 'confirmed' })
  assert.equal((await getAccount(connection, destination)).amount, 400_000_000n)
  assert.equal(vaultBefore - (await getAccount(connection, vaultOf(mint))).amount, 400_000_000n)
  await assert.rejects(release(hash2, outbox2))
  assert.equal((await getAccount(connection, destination)).amount, 400_000_000n)
})
