// Road build 3, step 3: Acrux's cblocks certified by the light client on a local Solana validator.
// Starts the validator with acrux_bridge and an Acrux net whose bridge rule starts at slot 0,
// seeds the light client with the validator set of the first finalized cblock, relays that cblock
// (certified, and the next epoch's set handed on from its outbox), then relays a cblock of the next
// epoch, certified by the set that was handed on. Stops both.
// Usage (from backend/chain): node scripts/bridge-light-client-check.mjs [acrux binary, from backend/node]
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Connection } from '@solana/web3.js'
import { devKeypair } from './dev-keys.mjs'
import { EPOCH_SLOTS, bridgeProgram, cblockProof, pdas, relay, seed } from './bridge-relay.mjs'

const chain = resolve(import.meta.dirname, '..')
const node = resolve(chain, '../node')
const acrux = resolve(node, process.argv[2] ?? 'target/release/acrux')
const program = 'EDm6HxGArNEgGfWRZwvj42f4euc9oPQWVUwUbkK3PEe5'
const gateway = 'http://127.0.0.1:4930'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rpc = async (url, method, params) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
const up = async (url) => { for (let i = 0; i < 120; i++) { if ((await rpc(url, 'getSlot', []).catch(() => 0)) > 2) return; await sleep(1000) } throw new Error(`${url} did not start`) }
const cblocksPerEpoch = EPOCH_SLOTS / 4

/// The proof of the first finalized cblock at or after `slot` that the gateway holds, waiting for it.
async function proofFrom(slot, seconds) {
  for (let t = 0; t < seconds; t++) {
    for (let c = slot; c < slot + 8; c++) {
      const proof = await cblockProof(gateway, c).catch(() => null)
      if (proof) return proof
    }
    await sleep(1000)
  }
  throw new Error(`no cblock proof from ${slot} after ${seconds} s`)
}

const state = join(chain, '.ledger')
rmSync(state, { recursive: true, force: true })
mkdirSync(state, { recursive: true })
const validator = spawn('bash', [join(chain, 'scripts/validator.sh'), state, '32', '--upgradeable-program', program, join(chain, 'target/deploy/acrux_bridge.so'), devKeypair('local-authority').publicKey.toBase58()], { stdio: 'ignore' })
const store = join(node, 'target/bridge-light-client-check')
rmSync(store, { recursive: true, force: true })
mkdirSync(store, { recursive: true })
const rule = join(store, 'bridge.json')
writeFileSync(rule, JSON.stringify({ program, fromSlot: 0 }))
const env = { ...process.env, ACRUX_BRIDGE: rule, ACRUX_BRIDGE_RPC: 'http://127.0.0.1:4990' }
const net = spawn(acrux, ['net', 'up', '--store', join(store, 'net')], { cwd: node, env, stdio: 'ignore' })
let ok = false
try {
  await up('http://127.0.0.1:4990')
  await up(gateway)
  const bridge = bridgeProgram(new Connection('http://127.0.0.1:4990', 'confirmed'), devKeypair('local-authority'))
  // Its outbox carries the next epoch's validator set.
  const opening = await proofFrom(1, 60)
  const epoch = Math.floor(opening.consensusSlot / cblocksPerEpoch)
  console.log(`cblock ${opening.consensusSlot} (epoch ${epoch}): ${opening.votes.length} votes, preimage ${Buffer.from(opening.preimage, 'base64').length} bytes, ${opening.outbox.length} outbox entr${opening.outbox.length === 1 ? 'y' : 'ies'}`)
  await seed(bridge, opening, epoch)
  const first = await relay(bridge, opening)
  console.log('relayed:', JSON.stringify(first))
  // A cblock of the next epoch, certified by the set the first one handed on.
  const next = await proofFrom((epoch + 1) * cblocksPerEpoch + 2, 150)
  const second = await relay(bridge, next)
  console.log('relayed:', JSON.stringify(second))
  const set = await bridge.account.validatorSet.fetch(pdas(bridge.programId).set(epoch + 1))
  console.log(`epoch ${epoch + 1} set on Solana: ${set.validators.length} validators, ${set.total.toString()} stake`)
  ok = first.certified && first.handedOn.includes(epoch + 1) && second.certified && second.epoch === epoch + 1
} finally {
  net.kill()
  validator.kill('SIGTERM')
  await sleep(2000)
  rmSync(state, { recursive: true, force: true })
}
console.log(ok ? 'cblocks certified on Solana, and the validator set handed to the next epoch' : 'FAILED')
process.exit(ok ? 0 : 1)
