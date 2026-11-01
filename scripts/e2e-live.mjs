#!/usr/bin/env node
// Live end-to-end check of session-transfer against a real Claude Code process.
//
//   node scripts/e2e-live.mjs [--model haiku] [--keep]
//
// What it proves, in one headless session (stream-json in and out):
//   1. every reply is archived to ~/.claude/session-transfer/<project>/threads/...
//   2. /handoff archives, copies the raw JSONL, runs /clear and starts a fresh session id
//   3. the fresh session starts with the handoff card (not the old context)
//   4. a fact that only ever appeared in a TOOL RESULT before the handoff
//      (so it is in neither the card nor the new context) is recovered through
//      the history tools
// It runs in a throwaway project folder and costs a few cents on Haiku.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'haiku'
const keep = args.includes('--keep')
const modDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const proj = mkdtempSync(join(tmpdir(), 'st-e2e-'))
writeFileSync(join(proj, 'README.md'), '# e2e scratch project\n')
// The secret lives only in a file the agent reads: it reaches the transcript
// only as a TOOL RESULT, never in a prompt, a reply, or the handoff card.
const secret = 'ZEBRA-' + Math.floor(1000 + Math.random() * 9000) + '-' + 'QUOKKA'
writeFileSync(join(proj, 'build-id.txt'), 'build id: ' + secret + '\n')
const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const slug = proj.replace(/[^A-Za-z0-9]/g, '-')
const base = join(cfg, 'session-transfer', slug)

const allowed = [
  'Read', 'ToolSearch',
  'mcp__session-transfer__history_index', 'mcp__session-transfer__history_search', 'mcp__session-transfer__history_read',
].join(',')
const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--plugin-dir', modDir, '--allowedTools', allowed], {
  cwd: proj,
  shell: process.platform === 'win32',
  env: { ...process.env, MSYS_NO_PATHCONV: '1' },
})

const events = []
let buf = ''
let waiters = []
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      events.push(ev)
      for (const w of waiters) w(ev)
    } catch {}
  }
})
let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })

function send(text) {
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
}
function waitFor(pred, ms = 180_000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { waiters = waiters.filter((w) => w !== fn); rej(new Error('timeout waiting')) }, ms)
    const fn = (ev) => { if (pred(ev)) { clearTimeout(t); waiters = waiters.filter((w) => w !== fn); res(ev) } }
    waiters.push(fn)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')) }

function threadDirs() {
  const t = join(base, 'threads')
  return existsSync(t) ? readdirSync(t).map((d) => join(t, d)) : []
}
function manifest() {
  const d = threadDirs()[0]
  return d && existsSync(join(d, 'thread.json')) ? JSON.parse(readFileSync(join(d, 'thread.json'), 'utf8')) : null
}

try {
  console.log('project ' + proj + '\nmodel ' + model + '\nsecret ' + secret)
  send('Read the file build-id.txt with the Read tool. Do not repeat its contents. Then reply with only the word: done')
  const r1 = await waitFor((e) => e.type === 'result')
  const sid1 = r1.session_id
  await sleep(1500)
  const m1 = manifest()
  check('reply archived to a verified chunk', !!m1 && m1.sessions[0].records >= 3 && m1.sessions[0].chunks.length >= 1, m1 ? m1.sessions[0].records + ' records, ' + m1.sessions[0].chunks.length + ' chunk(s)' : 'no manifest at ' + base)
  const chunkText = m1 ? readFileSync(join(threadDirs()[0], 'S1-' + String(m1.sessions[0].id).slice(0, 8), m1.sessions[0].chunks[0]), 'utf8') : ''
  check('the tool result holding the secret is in the archive', chunkText.includes(secret) && /@@ r\d+ result:Read/.test(chunkText) && !/@@ r\d+ user[^\n]*\n[^@]*ZEBRA/.test(chunkText))

  send('/handoff')
  let sid2 = null
  for (let i = 0; i < 40 && !sid2; i++) {
    await sleep(500)
    const m = manifest()
    if (m && m.sessions.length >= 2) sid2 = m.sessions[1].id
  }
  check('/handoff started a fresh session id', !!sid2 && sid2 !== sid1, sid1 + ' -> ' + sid2)
  const m2 = manifest()
  check('the raw JSONL transcript was copied', !!m2?.sessions[0]?.raw?.ok, JSON.stringify(m2?.sessions[0]?.raw ?? null))

  send('Earlier in this work you read a file that held a build id. What was the build id? Answer from the archived history, not by reading the file again. Reply with only the id.')
  const r3 = await waitFor((e) => e.type === 'result')
  const answer = String(r3.result ?? '')
  check('fresh session runs on a new id', r3.session_id && r3.session_id !== sid1, r3.session_id)
  const toolUses = events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name))
  check('the history tools were used after the handoff', toolUses.some((n) => /history_(search|read|index)/.test(n)), toolUses.join(', '))
  check('the fact from before the handoff was recovered', answer.includes(secret), JSON.stringify(answer.slice(0, 120)))
  const sid2Transcript = join(cfg, 'projects', slug, r3.session_id + '.jsonl')
  const t2 = existsSync(sid2Transcript) ? readFileSync(sid2Transcript, 'utf8') : ''
  // The transcript is JSONL, so the card sits JSON-escaped inside it; slice it out as is.
  const at = t2.indexOf('<session-transfer-handoff thread=')
  const card = at >= 0 ? t2.slice(at, t2.indexOf('</session-transfer-handoff>', at) + 27) : ''
  check('the fresh session received the handoff card', !!card, card ? card.length + ' chars' : 'not found in ' + sid2Transcript)
  check('the card does not contain the secret (so the answer came from a lookup)', !!card && !card.includes(secret))
  check('the secret was not re-read from the file after the handoff', !events.filter((e) => e.type === 'assistant' && e.session_id === r3.session_id).some((e) => (e.message?.content ?? []).some((c) => c.type === 'tool_use' && c.name === 'Read')))
  const firstAfter = events.filter((e) => e.type === 'assistant' && e.session_id === r3.session_id)[0]
  const u = firstAfter?.message?.usage
  if (u) console.log('first request after handoff: prompt ' + (u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens) + ' tokens')
} catch (err) {
  check('run completed', false, String(err.message) + '\n' + stderr.slice(-2000))
} finally {
  child.stdin.end()
  await sleep(500)
  child.kill()
  const failed = results.filter((r) => !r.ok).length
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed. Archive: ' + base)
  if (!keep) {
    try { rmSync(proj, { recursive: true, force: true }) } catch {}
  }
  process.exit(failed ? 1 : 0)
}
