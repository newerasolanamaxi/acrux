// Starts the local validator (hub_registry, demo_pool and acrux_bridge loaded), runs the
// test files against it, and stops it again. The Hub Registry's own suite initializes the
// registry, so it runs on a validator of its own without the Acrux Net genesis accounts, the
// registry's among them; the other suites run with them.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection } from '@solana/web3.js'
import { chainDir, devKeypair } from '../scripts/dev-keys.mjs'
import { RPC_URL } from '../scripts/registry.mjs'

const state = join(chainDir, '.ledger')
const accounts = join(state, 'accounts')
const genesis = JSON.parse(readFileSync(join(chainDir, 'genesis/acrux-net.json'), 'utf8'))

async function suite(files, withGenesis) {
  rmSync(state, { recursive: true, force: true })
  mkdirSync(accounts, { recursive: true })
  for (const a of withGenesis ? genesis.accounts : []) {
    writeFileSync(join(accounts, `${a.address}.json`), JSON.stringify({
      pubkey: a.address,
      account: { lamports: a.lamports, data: [a.data, 'base64'], owner: a.owner, executable: a.executable, rentEpoch: 0 },
    }))
  }
  const validator = spawn('bash', [
    join(chainDir, 'scripts/validator.sh'), state, '32',
    '--bpf-program', genesis.programs[0].address, join(chainDir, genesis.programs[0].path),
    '--account-dir', accounts,
    // The bridge, built beside the genesis programs.
    '--upgradeable-program', 'EDm6HxGArNEgGfWRZwvj42f4euc9oPQWVUwUbkK3PEe5', join(chainDir, 'target/deploy/acrux_bridge.so'), devKeypair('local-authority').publicKey.toBase58(),
  ], { stdio: 'ignore' })
  let status = 1
  try {
    const connection = new Connection(RPC_URL, 'confirmed')
    for (let i = 0; ; i++) {
      if (validator.exitCode !== null) throw new Error('The validator exited; see .ledger/validator.log')
      if ((await connection.getSlot().catch(() => 0)) > 1) break
      if (i > 120) throw new Error('The validator did not start')
      await new Promise((r) => setTimeout(r, 500))
    }
    status = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: chainDir, stdio: 'inherit' }).status ?? 1
  } finally {
    // Stop exactly the validator this run started.
    if (validator.exitCode === null) {
      validator.kill('SIGTERM')
      await new Promise((r) => validator.once('exit', r))
    }
  }
  return status
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['tests/hub_registry.test.mjs', 'tests/demo_pool.test.mjs', 'tests/acrux_bridge.test.mjs']
const registry = files.filter(f => f.includes('hub_registry'))
const rest = files.filter(f => !f.includes('hub_registry'))
let status = 0
if (registry.length) status ||= await suite(registry, false)
if (rest.length) status ||= await suite(rest, true)
if (status === 0) rmSync(state, { recursive: true, force: true })
process.exit(status)
