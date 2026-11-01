#!/usr/bin/env node
// Mutation check for the approval rules: plants one bug at a time, runs
// `claude plugin test`, and requires the suite to FAIL. A mutation that
// survives means a test gives a GO without testing. Restores every file.
//
//   node scripts/mutation-check.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MUTANTS = [
  {
    name: 'supervised sessions swap without asking',
    file: 'hooks/lib.js',
    from: "  if (unattended) return autoContinue && stopped ? 'swap-continue' : 'arm'",
    to: "  if (true) return autoContinue && stopped ? 'swap-continue' : 'arm'",
  },
  {
    name: 'a "no" (or a dismissal) still swaps',
    file: 'hooks/register.js',
    from: '    if (answer === q.yes) {',
    to: '    if (true) {',
  },
  {
    name: 'supervised prompts are intercepted and moved',
    file: 'hooks/register.js',
    from: '    if (armed && isUnattended() && settings.mode',
    to: '    if (armed && settings.mode',
  },
  {
    name: 'manual mode asks anyway',
    file: 'hooks/lib.js',
    from: "  if (mode === 'auto' && canAsk && tokens >= (snoozeUntil ?? 0)) return 'suggest'",
    to: "  if (canAsk && tokens >= (snoozeUntil ?? 0)) return 'suggest'",
  },
  {
    name: 'a "no" is not remembered: it asks on every turn',
    file: 'hooks/lib.js',
    from: '  return Math.round(tokens + limit * 0.15)',
    to: '  return 0',
  },
  {
    name: 'unattended is not kept on the thread (lost at the first swap)',
    file: 'hooks/register.js',
    from: '  if (thread) { thread.unattended = on; try { await saveManifest($) } catch {} }',
    to: '  if (thread) { try { await saveManifest($) } catch {} }',
  },
  {
    name: 'the environment cannot force unattended',
    file: 'hooks/register.js',
    from: '  if (ctx?.envUnattended) return true',
    to: '  if (false) return true',
  },
  {
    name: 'a manual /clear inherits unattended',
    file: 'hooks/register.js',
    from: '  unattendedPre = false // new work starts supervised',
    to: '  // unattendedPre = false // new work starts supervised',
  },
  {
    name: 'no growth floor: a fresh session over the limit by its own base swaps again (unattended loops)',
    file: 'hooks/lib.js',
    from: '  if (!grewEnough(tokens, floor, limit)) return',
    to: '  if (false) return',
  },
  {
    name: 'the floor is never measured',
    file: 'hooks/register.js',
    from: '  if (floor === null) floor = prompt',
    to: '  // if (floor === null) floor = prompt',
  },
  {
    name: 'the context note promises an automatic swap to supervised sessions',
    file: 'hooks/lib.js',
    from: '  if (unattended && autoContinue) {',
    to: '  if (autoContinue) {',
  },
]

function run() {
  try {
    execFileSync('claude', ['plugin', 'test', root], { stdio: 'pipe', shell: process.platform === 'win32', encoding: 'utf8' })
    return { failed: 0 }
  } catch (err) {
    const out = String(err.stdout ?? '') + String(err.stderr ?? '')
    const m = /(\d+) fail/.exec(out)
    return { failed: m ? Number(m[1]) : -1 }
  }
}

let survived = 0
for (const mu of MUTANTS) {
  const path = resolve(root, mu.file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(mu.from)) {
    console.log('SKIP  ' + mu.name + ' (anchor not found: the code changed; update this mutant)')
    survived++
    continue
  }
  writeFileSync(path, original.replace(mu.from, mu.to))
  let r
  try { r = run() } finally { writeFileSync(path, original) }
  const killed = r.failed !== 0
  if (!killed) survived++
  console.log((killed ? 'KILLED ' : 'SURVIVED ') + mu.name + (killed ? '  (' + r.failed + ' test' + (r.failed === 1 ? '' : 's') + ' failed)' : ''))
}
const clean = run()
console.log('\n' + (MUTANTS.length - survived) + '/' + MUTANTS.length + ' mutants killed. Unmutated suite: ' + (clean.failed === 0 ? 'green' : clean.failed + ' failing'))
process.exit(survived || clean.failed ? 1 : 0)
