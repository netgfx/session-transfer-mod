// session-transfer: continue long Claude Code sessions in fresh, small
// contexts instead of compacting them, with the whole history kept on disk
// as a searchable archive the new session looks things up in.
//
// The technique follows mainplane (github.com/mainplane-ai/mainplane):
// an append-only log of every record, a hard context limit the agent can
// see, and a /continue that starts a blank session pointing at the old log
// instead of summarizing it. No code from mainplane is used.
//
// Flow
//   every reply      new transcript messages -> immutable chunk files (verified)
//   near the limit   Claude is told its context size, so it stops cleanly
//   at the limit     the next message (or Claude's stop) triggers a handoff:
//                    archive -> copy raw JSONL -> /clear -> card rides on the
//                    first prompt of the fresh session
//   auto-compaction  answered in place with the card (no summarizer call)
//   any time         /handoff, the band button, or the pane

import {
  normalizeSettings, settingsOverrides, handoffLimit, capByCompaction, levelOf, newMessages, nextCursor, toRecords, buildChunks, parseChunk, mergeParts, lineageRecords,
  chunkName, turnIndex, searchRecords, parseRef, readRecords, buildCard, emergencyMessages, messageChars,
  telemetryNote, noteDue, emptyStats, addRequest, projectSlug, joinPath, newThreadId, sessionDirName,
  nextSessionKey, newThread, newSessionEntry, psQuote, tokensOf, short, firstLine, clockTime, CHARS_PER_TOKEN,
  limitAction, snoozeAfterNo, suggestQuestion, grewEnough,
} from './lib.js'
import { band, pane } from './view.js'

const PLUGIN = 'session-transfer'
const PANE = 'session-transfer'
const CARD_RE = /<session-transfer-handoff[\s\S]*?<\/session-transfer-handoff>\s*/g
const CONTINUE_TEXT = 'Continue the task from where the previous session stopped. The handoff card says where everything is; look up anything you need before acting.'

// ---------------------------------------------------------------- module state
// Lost on hot reload; bindSession() rebuilds it from the manifest on disk.

let settings = normalizeSettings(null)
let ctx = null // { cwd, root, platform, cfg, base }
let sid = null
let thread = null // the manifest (thread.json) in memory
let session = null // the current session's entry inside thread.sessions
let records = [] // records of the thread, loaded lazily from chunks
let recordsLoaded = false
let looseStats = emptyStats() // usage seen before the thread's first write
let usageNow = { tokens: 0, window: 0, percent: 0 }
let compactAt = 0 // Claude Code's own auto-compaction point; 0 = unknown or off
let compactFor = -1 // the window compactAt was read for: read again when the model changes
let phase = null
let failure = null
let pending = null // { sid, card, from, tokens }
let armed = false
let stopRequested = false
let handoffRequested = null // a handoff asked for mid-turn: { continueText }
let turnRunning = false
let noteState = { level: 'ok', calls: 0 }
let lastWrite = null
let tab = 'overview'
let searchResult = null
let offerThread = null
let queue = Promise.resolve()
let handoffBusy = false
let clearWaiter = null
let transcriptPaths = {} // sid -> transcript_path from classic hook inputs
let unattendedPre = false // the per-session choice made before the thread's first write
let snoozeUntil = 0 // after a "no", ask again only past this many tokens
let asking = false
let floor = null // this session's first prompt size: it can't hand off below this

/** Unattended swaps without asking. Per session (kept on the thread, so it survives its own handoffs), or forced for the process by SESSION_TRANSFER_UNATTENDED=1. */
function isUnattended() {
  if (ctx?.envUnattended) return true
  return thread ? !!thread.unattended : unattendedPre
}

async function setUnattended($, on) {
  unattendedPre = on
  if (thread) { thread.unattended = on; try { await saveManifest($) } catch {} }
  $.ui.invalidate('ui.render')
}

/** The yes/no suggestion. Nothing swaps without a yes; a dismissal or no one to ask counts as no. */
async function suggestHandoff($, continueTask) {
  if (asking || handoffBusy) return
  asking = true
  $.ui.invalidate('ui.render')
  try {
    const q = suggestQuestion({ tokens: usageNow.tokens, limit: currentLimit(), sessionKey: session?.key ?? 'S1', continueTask })
    let answer = null
    try { answer = await $.ui.ask(q.question, [q.yes, q.no]) } catch {}
    if (answer === q.yes) {
      scheduleHandoff($, continueTask && settings.autoContinue ? { reason: 'limit', continueText: CONTINUE_TEXT } : { reason: 'limit' })
    } else {
      snoozeUntil = snoozeAfterNo(usageNow.tokens, currentLimit())
      $.ui.toast('Staying in this session. Asking again at ' + short(snoozeUntil) + ' tokens; hand off any time from the band or /handoff.')
    }
  } finally {
    asking = false
    $.ui.invalidate('ui.render')
  }
}

// ---------------------------------------------------------------- helpers ($ passed to top-level functions only)

async function nowIso($) {
  return new Date(await $.clock.now()).toISOString()
}

async function ensureCtx($) {
  if (ctx) return ctx
  const cwd = await $.session.cwd()
  let root = cwd
  try { root = (await $.session.root()) || cwd } catch {}
  let platform = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? 'windows' : 'posix'
  if (platform === 'posix' && (await $.env.get('OS')) === 'Windows_NT') platform = 'windows'
  const home = platform === 'windows' ? (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) : (await $.env.get('HOME')) || ''
  const cfg = (await $.env.get('CLAUDE_CONFIG_DIR')) || joinPath(home, '.claude')
  const envUnattended = (await $.env.get('SESSION_TRANSFER_UNATTENDED')) === '1'
  const envLimit = Math.round(Number(await $.env.get('SESSION_TRANSFER_LIMIT'))) || 0 // tokens; servers and demos
  ctx = { cwd, root, platform, cfg, envUnattended, envLimit, base: joinPath(cfg, 'session-transfer', projectSlug(root)) }
  return ctx
}

function threadDir() {
  return joinPath(ctx.base, 'threads', thread.id)
}

function sessionDir(entry) {
  return joinPath(threadDir(), sessionDirName(entry.key, entry.id))
}

function stats() {
  return thread ? thread.stats : looseStats
}

function currentLimit() {
  if (ctx?.envLimit > 0) return ctx.envLimit
  return capByCompaction(handoffLimit(settings, usageNow.window || 200_000), compactAt)
}

async function loadSettings($) {
  try { settings = normalizeSettings(await $.store.get('settings')) } catch { settings = normalizeSettings(null) }
}

/**
 * Writes the manifest as a commit: the previous good one is kept as
 * thread.prev.json, the new one is read back and parsed before it counts.
 * Takes the manifest to write, so callers can stage changes and apply them
 * in memory only after this resolves.
 */
async function writeManifest($, t) {
  const dir = joinPath(ctx.base, 'threads', t.id)
  const path = joinPath(dir, 'thread.json')
  const text = JSON.stringify(t, null, 1)
  try {
    if (await $.fs.exists(path)) {
      const old = String(await $.fs.read(path))
      JSON.parse(old) // only a good manifest becomes the backup
      await $.fs.write(joinPath(dir, 'thread.prev.json'), old)
    }
  } catch {}
  await $.fs.write(path, text)
  const back = String(await $.fs.read(path))
  if (back !== text) throw new Error('manifest read-back mismatch')
  await $.fs.write(joinPath(ctx.base, 'latest.json'), JSON.stringify({ thread: t.id, sid, at: await nowIso($) }))
}

async function saveManifest($) {
  if (thread) await writeManifest($, thread)
}

async function readJson($, path) {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(String(await $.fs.read(path)).replace(/^﻿/, ''))
  } catch {
    return null
  }
}

const CHUNK_FILE = /^c(\d{6})-r(\d+)-r(\d+)\.md$/

/**
 * Loads a thread's manifest (or its backup) and re-adopts chunk files the
 * manifest doesn't list: chunks are self-describing and immutable, so a
 * write that landed before a failed manifest commit is never lost.
 */
async function loadThread($, id) {
  await ensureCtx($)
  const dir = joinPath(ctx.base, 'threads', id)
  const t = (await readJson($, joinPath(dir, 'thread.json'))) ?? (await readJson($, joinPath(dir, 'thread.prev.json')))
  if (!t) return false
  thread = { ...t, stats: { ...emptyStats(), ...(t.stats ?? {}) } }
  records = []
  recordsLoaded = false
  let adopted = 0
  for (const s of thread.sessions) {
    let entries = []
    try { entries = await $.fs.list(sessionDir(s)) } catch { continue }
    const known = new Set(s.chunks ?? [])
    for (const e of entries) {
      const m = CHUNK_FILE.exec(e.name)
      if (!m || known.has(e.name)) continue
      s.chunks = [...(s.chunks ?? []), e.name].sort()
      thread.chunkSeq = Math.max(thread.chunkSeq ?? 0, Number(m[1]))
      thread.nextN = Math.max(thread.nextN ?? 1, Number(m[3]) + 1)
      s.coverage = s.coverage === 'complete' ? 'complete (recovered ' + e.name + ')' : s.coverage
      adopted++
    }
  }
  if (adopted) { try { await saveManifest($) } catch {} }
  return true
}

/** Loads every chunk of the thread into memory once; chunks are immutable, so the cache never goes stale. */
async function loadRecords($) {
  if (!thread || recordsLoaded) return records
  const all = []
  for (const s of thread.sessions) {
    for (const name of s.chunks ?? []) {
      try {
        all.push(...parseChunk(await $.fs.read(joinPath(sessionDir(s), name))))
      } catch (err) {
        s.coverage = 'chunk unreadable: ' + name
      }
    }
  }
  records = mergeParts(all)
  recordsLoaded = true
  return records
}

async function ensureThread($) {
  await ensureCtx($)
  if (thread && session) return
  if (!sid) sid = await $.session.id()
  const now = await nowIso($)
  thread = newThread(newThreadId(await $.clock.now(), sid), now, ctx.root)
  thread.stats = { ...looseStats }
  thread.unattended = unattendedPre
  session = newSessionEntry('S1', sid, null, 'start', now)
  thread.sessions.push(session)
  records = []
  recordsLoaded = true
  offerThread = null
  await $.store.set('sess:' + sid, { thread: thread.id })
  await $.fs.write(joinPath(ctx.base, 'README.md'), ARCHIVE_README)
}

function runQueued(fn) {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

/**
 * Archives the messages the cursor hasn't seen, as a transaction:
 *   1. stage: records, chunk names and the next manifest, built on a copy
 *   2. write each chunk and read it back whole
 *   3. commit the manifest (verified)
 *   4. only then advance the cursor and counters in memory
 * The session and thread are captured at the start, so a rebind while this
 * awaits can't send records to the wrong session.
 */
async function archiveMessages($, msgs, why) {
  await ensureThread($)
  const t = thread
  const entry = session
  const { fresh, gap } = newMessages(msgs, entry.cursor)
  if (!fresh.length) return 0
  const now = await nowIso($)
  const clean = fresh.map((m) => (m.role === 'user' && String(m.text ?? '').includes('<session-transfer-handoff') ? { ...m, text: String(m.text).replace(CARD_RE, '[session-transfer handoff card]\n') } : m))
  const { records: recs, nextN, turn } = toRecords(clean, { startN: t.nextN, startTurn: entry.turn, sessionKey: entry.key, time: now })
  const staged = JSON.parse(JSON.stringify(t))
  const se = staged.sessions.find((x) => x.key === entry.key)
  const dir = sessionDir(entry)
  let bytes = 0
  for (const c of buildChunks(recs, { thread: t.id, s: entry.key, sid: entry.id, time: now })) {
    staged.chunkSeq += 1
    const name = chunkName(staged.chunkSeq, c.from, c.to)
    const path = joinPath(dir, name)
    await $.fs.write(path, c.text)
    const back = String(await $.fs.read(path))
    if (back !== c.text) throw new Error('read-back mismatch in ' + name)
    se.chunks.push(name)
    bytes += c.text.length
  }
  if (gap) se.coverage = 'unproven before r' + t.nextN + ' (' + why + (msgs.length >= 4096 ? ', the transcript window was full' : '') + ')'
  if (!staged.firstAsk) {
    const first = recs.find((r) => r.kind === 'user')
    if (first) staged.firstAsk = firstLine(first.body.replace(/\[session-transfer handoff card\]\s*/, ''), 400)
  }
  staged.nextN = nextN
  se.turn = turn
  se.records += recs.length
  se.bytes = (se.bytes ?? 0) + bytes
  se.cursor = nextCursor(entry.cursor, fresh, msgs)
  staged.stats = t.stats // live counters, not part of this transaction
  await writeManifest($, staged)
  // committed: apply to memory
  Object.assign(t, { chunkSeq: staged.chunkSeq, nextN: staged.nextN, firstAsk: staged.firstAsk })
  Object.assign(entry, { chunks: se.chunks, coverage: se.coverage, turn: se.turn, records: se.records, bytes: se.bytes, cursor: se.cursor })
  if (recordsLoaded && thread === t) records.push(...recs)
  lastWrite = { time: now, ok: true, why }
  return recs.length
}

async function archiveNow($, why) {
  try {
    const msgs = await $.session.messages()
    return await runQueued(() => archiveMessages($, msgs, why))
  } catch (err) {
    lastWrite = { time: await nowIso($), ok: false, error: String(err?.message ?? err) }
    throw err
  }
}

/** Copies Claude Code's own JSONL transcript (and its subagents folder) next to the archive. */
async function copyRaw($, entry) {
  await ensureCtx($)
  const id = entry.id
  const candidates = [transcriptPaths[id], joinPath(ctx.cfg, 'projects', projectSlug(ctx.root), id + '.jsonl'), joinPath(ctx.cfg, 'projects', projectSlug(ctx.cwd), id + '.jsonl')].filter(Boolean)
  let src = null
  for (const c of candidates) {
    try { if (await $.fs.exists(c)) { src = c; break } } catch {}
  }
  if (!src) {
    entry.raw = { ok: false, note: 'transcript not found' }
    return entry.raw
  }
  const rawDir = joinPath(threadDir(), 'raw')
  await $.fs.write(joinPath(rawDir, 'README.txt'), 'Copies of Claude Code transcripts (JSONL), one per session, taken at each handoff. They hold every byte the archive might have cut.\n')
  const dst = joinPath(rawDir, id + '.jsonl')
  const srcDir = src.replace(/\.jsonl$/i, '')
  const dstDir = joinPath(rawDir, id)
  try {
    let r
    if (ctx.platform === 'windows') {
      const cmd = 'Copy-Item -LiteralPath ' + psQuote(src) + ' -Destination ' + psQuote(dst) + ' -Force; if (Test-Path -LiteralPath ' + psQuote(srcDir) + ') { Copy-Item -LiteralPath ' + psQuote(srcDir) + ' -Destination ' + psQuote(dstDir) + ' -Recurse -Force }'
      r = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd], { timeoutMs: 120_000 })
    } else {
      r = await $.process.run(['cp', '-f', src, dst], { timeoutMs: 120_000 })
      if (r.exitCode === 0 && (await $.fs.exists(srcDir))) r = await $.process.run(['cp', '-R', srcDir, dstDir], { timeoutMs: 120_000 })
    }
    entry.raw = r.exitCode === 0 ? { ok: true, path: dst, at: await nowIso($) } : { ok: false, note: String(r.stderr || 'copy failed').slice(0, 200) }
  } catch (err) {
    entry.raw = { ok: false, note: String(err?.message ?? err).slice(0, 200) }
  }
  return entry.raw
}

async function refreshUsage($) {
  try {
    const { context } = await $.session.usage()
    if (context?.window) usageNow = { tokens: context.tokens ?? 0, window: context.window, percent: context.percent ?? Math.round(((context.tokens ?? 0) / context.window) * 100) }
  } catch {}
  if (usageNow.window && compactFor !== usageNow.window) await readCompactPoint($)
}

// Where Claude Code compacts on its own. The 'summary' breakdown is estimated
// locally (no API call); it is read once per window, so a /model switch or a
// changed CLAUDE_CODE_AUTO_COMPACT_WINDOW in a new session is picked up.
async function readCompactPoint($) {
  compactFor = usageNow.window
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context?.breakdown
    compactAt = b && b.isAutoCompactEnabled !== false && b.autoCompactThreshold > 0 ? b.autoCompactThreshold : 0
  } catch {
    compactAt = 0
  }
}

async function gitBranch($) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

/** The card, built only from the speaking session's own lineage (never a sibling branch's work). */
async function makeCard($, extra) {
  await loadRecords($)
  const fromKey = extra.fromKey ?? session.key
  const raws = thread.sessions.filter((x) => x.raw?.ok).length
  return buildCard({
    thread: thread.id,
    fromKey,
    archiveDir: threadDir(),
    totalRecords: thread.nextN - 1,
    sessions: thread.sessions.length,
    coverage: thread.sessions.every((x) => String(x.coverage).startsWith('complete')) ? 'complete' : 'partial (see history_index)',
    rawCopies: raws ? raws + ' of ' + thread.sessions.length + ' in raw/' : '',
    firstAsk: thread.firstAsk,
    notes: thread.notes,
    records: lineageRecords(records, thread.sessions, fromKey),
    cwd: ctx.cwd,
    branch: await gitBranch($),
    ...extra,
  })
}

/** Waits for the session id to change after /clear: the classic SessionStart hook, or polling as a fallback. */
async function waitForNewSession($, waiter, from) {
  let found = null
  waiter.then((id) => { found = id })
  for (let i = 0; i < 40 && !found; i++) {
    await $.clock.sleep(200)
    try {
      const id = await $.session.id()
      if (id && id !== from) found = id
    } catch {}
  }
  return found
}

/** The card waiting for the fresh session's first message, kept in the store so a reload can't lose it. */
async function setPending($, p) {
  pending = p
  try { p ? await $.store.set('pending', p) : await $.store.delete('pending') } catch {}
}

async function delivered($) {
  await setPending($, null)
  try { await $.store.delete('op') } catch {}
}

/**
 * The handoff, as a recoverable transaction. The caller has reserved it
 * (handoffBusy) and starts it from a timer, so /clear runs outside any hook
 * the turn waits on. Each phase is persisted in $.store under op; op is
 * removed only once the card was delivered.
 */
async function handoff($, opts) {
  handoffBusy = true
  failure = null
  const fromSid = sid
  let op = null
  try {
    phase = 'archiving'
    $.ui.invalidate('ui.render')
    await archiveNow($, 'handoff')
    const fromEntry = session
    const t = thread
    phase = 'copying'
    $.ui.invalidate('ui.render')
    await copyRaw($, fromEntry)
    await refreshUsage($)
    const toKey = nextSessionKey(t)
    const card = await makeCard($, { fromKey: fromEntry.key, toKey, resubmitted: !!opts.resubmit, continueTask: !!opts.continueText })
    const tokensBefore = usageNow.tokens
    op = { id: fromSid + ':' + toKey, from: fromSid, fromKey: fromEntry.key, toKey, thread: t.id, reason: opts.reason, phase: 'clearing', at: await nowIso($), resubmit: opts.resubmit ?? null }
    await $.store.set('op', op)
    phase = 'clearing'
    $.ui.invalidate('ui.render')
    const waiter = new Promise((resolve) => { clearWaiter = { from: fromSid, resolve } })
    await $.command.run({ command: 'clear' })
    const newSid = await waitForNewSession($, waiter, fromSid)
    clearWaiter = null
    if (!newSid) throw new Error('the fresh session did not start; nothing was cleared')
    const now = await nowIso($)
    const entry = newSessionEntry(toKey, newSid, fromEntry.key, opts.reason, now)
    t.sessions.push(entry)
    fromEntry.handoff = { at: now, to: toKey, tokensBefore, reason: opts.reason }
    fromEntry.endedAt = now
    const st = t.stats
    st.handoffs = [...st.handoffs, { kind: 'handoff', from: fromEntry.key, to: toKey, at: now, tokensBefore, cardTokens: tokensOf(card), firstPrompt: null, requestsAfter: 0, reason: opts.reason }]
    st.marks = [...st.marks, st.samples.length]
    thread = t
    sid = newSid
    session = entry
    resetSessionFlags()
    usageNow = { ...usageNow, tokens: 0, percent: 0 }
    await setPending($, { sid: newSid, card, from: fromEntry.key, tokens: tokensOf(card) })
    await $.store.set('sess:' + newSid, { thread: t.id })
    await saveManifest($)
    op = { ...op, phase: 'cleared', to: newSid }
    await $.store.set('op', op)
    phase = null
    if (opts.resubmit) {
      $.prompt.submit({ text: opts.resubmit, asUser: true }).catch(async () => {
        failure = 'could not send your message; it is back in the prompt'
        try { await $.prompt.fill({ text: opts.resubmit }) } catch {}
      })
    } else if (opts.continueText) {
      $.prompt.submit({ text: opts.continueText }).catch(() => { failure = 'could not start the continuation; type "continue"' })
    } else {
      $.ui.toast('Fresh session ' + toKey + ' ready. The handoff card rides on your next message.')
    }
  } catch (err) {
    failure = String(err?.message ?? err).slice(0, 160)
    if (op) { try { await $.store.set('op', { ...op, phase: 'failed', error: failure }) } catch {} }
    if (opts.resubmit) { try { await $.prompt.fill({ text: opts.resubmit }) } catch {} }
    $.ui.log('session-transfer: handoff failed: ' + failure, { to: 'debug' })
  } finally {
    phase = null
    handoffBusy = false
    clearWaiter = null
    $.ui.invalidate('ui.render')
  }
}

/**
 * Reserves the one handoff slot at once, so a second request (a button, a
 * prompt the auto mode holds) can never start a parallel run and lose its
 * message. Returns false when a handoff is already under way.
 */
function scheduleHandoff($, opts) {
  if (handoffBusy) {
    $.ui.toast('A handoff is already under way.')
    return false
  }
  handoffBusy = true
  if (turnRunning) {
    handoffRequested = opts
    $.ui.toast('Handoff queued: it runs when this turn ends.')
    $.ui.invalidate('ui.render')
    return true
  }
  $.clock.after(20, () => { handoff($, opts) })
  return true
}

/** Flags that belong to one session; a rebind must never carry them into another. */
function resetSessionFlags() {
  snoozeUntil = 0
  floor = null
  armed = false
  stopRequested = false
  noteState = { level: 'ok', calls: 0 }
  lastWrite = null
  if (handoffRequested) { handoffRequested = null; handoffBusy = false }
}

/** Binds module state to the session the engine is running now (serialized with archive writes). */
async function bindSession($, source) {
  await ensureCtx($)
  const id = await $.session.id()
  if (clearWaiter && id !== clearWaiter.from) {
    const w = clearWaiter
    clearWaiter = null
    w.resolve(id) // our own /clear: handoff() takes it from here
    return
  }
  return runQueued(() => bindInner($, source, id))
}

async function bindInner($, source, id) {
  if (id === sid && thread) return
  const prevThread = thread
  const prevSession = session
  sid = id
  resetSessionFlags()
  try {
    const p = await $.store.get('pending')
    pending = p?.sid === id ? p : null
  } catch { pending = null }
  let mapped = null
  try { mapped = await $.store.get('sess:' + id) } catch {}
  if (mapped?.thread && (await loadThread($, mapped.thread))) {
    session = thread.sessions.find((x) => x.id === id) ?? null
    if (!session) {
      session = newSessionEntry(nextSessionKey(thread), id, null, 'resume', await nowIso($))
      thread.sessions.push(session)
    }
    return
  }
  // A /branch copies the conversation: keep the thread, start a child that skips what is archived.
  if (source === 'fork' && prevThread && prevSession) {
    thread = prevThread
    session = newSessionEntry(nextSessionKey(thread), id, prevSession.key, 'branch', await nowIso($))
    session.cursor = { ...prevSession.cursor }
    session.turn = prevSession.turn
    session.forkAt = thread.nextN // the parent's later records are not this branch's history
    thread.sessions.push(session)
    await $.store.set('sess:' + id, { thread: thread.id })
    await saveManifest($)
    return
  }
  thread = null
  session = null
  records = []
  recordsLoaded = false
  looseStats = emptyStats()
  unattendedPre = false // new work starts supervised; continuing a thread keeps its choice
  const latest = await readJson($, joinPath(ctx.base, 'latest.json'))
  if (latest?.thread) {
    const t = await readJson($, joinPath(ctx.base, 'threads', latest.thread, 'thread.json'))
    if (t) offerThread = { id: t.id, sessions: (t.sessions ?? []).length, ageMs: Math.max(0, (await $.clock.now()) - Date.parse(latest.at ?? t.created)) }
  }
}

/**
 * After a reload (or a crash) in the middle of a handoff: a message the auto
 * mode held is put back in the prompt rather than replayed blindly, and the
 * user is told. A delivered or failed handoff needs nothing.
 */
async function recoverOp($) {
  let op = null
  try { op = await $.store.get('op') } catch {}
  if (!op || op.phase === 'failed' || handoffBusy) return
  if (op.phase === 'clearing' && op.from === sid) {
    failure = 'a handoff was interrupted before the fresh session started; nothing was cleared'
    if (op.resubmit) { try { await $.prompt.fill({ text: op.resubmit }) } catch {} }
    try { await $.store.set('op', { ...op, phase: 'failed', error: failure }) } catch {}
  } else if (op.phase === 'clearing' && op.resubmit) {
    // /clear ran but the card was never built into a pending note: give the message back
    try { await $.prompt.fill({ text: op.resubmit }) } catch {}
    try { await $.store.set('op', { ...op, phase: 'failed', error: 'interrupted after /clear' }) } catch {}
  }
}

async function attachThread($) {
  if (!offerThread) return
  const id = offerThread.id
  offerThread = null
  if (!(await loadThread($, id))) { failure = 'thread ' + id + ' could not be read'; return }
  const last = thread.sessions[thread.sessions.length - 1]
  const toKey = nextSessionKey(thread)
  const card = await makeCard($, { fromKey: last?.key, toKey, continueTask: false })
  session = newSessionEntry(toKey, sid, last?.key ?? null, 'attach', await nowIso($))
  thread.sessions.push(session)
  thread.stats.handoffs = [...thread.stats.handoffs, { kind: 'handoff', from: last?.key, to: toKey, at: await nowIso($), tokensBefore: 0, cardTokens: tokensOf(card), firstPrompt: null, requestsAfter: 0, reason: 'attach' }]
  await setPending($, { sid, card, from: last?.key ?? 'S?', tokens: tokensOf(card) })
  await $.store.set('sess:' + sid, { thread: thread.id })
  await saveManifest($)
}

function onRequest(usage) {
  const st = addRequest(stats(), usage)
  const prompt = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0)
  // The handoff that started this session (the newest one into it: a resumed session keeps its own).
  let into = null
  for (let i = st.handoffs.length - 1; i >= 0 && session; i--) if (st.handoffs[i].to === session.key) { into = st.handoffs[i]; break }
  if (into) {
    if (into.firstPrompt === null) into.firstPrompt = prompt
    into.requestsAfter = (into.requestsAfter ?? 0) + 1
  }
  if (thread) thread.stats = st
  else looseStats = st
  if (floor === null) floor = prompt
  if (usageNow.window) usageNow = { ...usageNow, tokens: prompt, percent: Math.round((prompt / usageNow.window) * 100) }
}

function countLookup(text) {
  const st = stats()
  st.lookups = { calls: (st.lookups?.calls ?? 0) + 1, chars: (st.lookups?.chars ?? 0) + String(text).length }
}

// ---------------------------------------------------------------- lookup tools

function noArchive() {
  return 'No archive for this session yet. It starts after the first reply. (session-transfer)'
}

async function toolIndex($, e) {
  if (!thread) return noArchive()
  await loadRecords($)
  const sess = e.session && e.session !== 'all' ? String(e.session).toUpperCase() : ''
  const turns = turnIndex(records).filter((t) => !sess || t.s === sess)
  const limit = Math.min(200, Math.max(5, Number(e.limit) || 40))
  const skip = Math.max(0, Number(e.cursor) || 0)
  const end = Math.max(0, turns.length - skip)
  const page = turns.slice(Math.max(0, end - limit), end)
  const lines = []
  lines.push('Thread ' + thread.id + ' · ' + thread.sessions.length + ' sessions · ' + turns.length + ' turns' + (sess ? ' in ' + sess : '') + ' · ' + (thread.nextN - 1) + ' records')
  lines.push('Archive: ' + threadDir())
  if (thread.firstAsk) lines.push('Goal (S1 T1): ' + thread.firstAsk)
  for (const s of thread.sessions) {
    lines.push(s.key + ' ' + String(s.id).slice(0, 8) + (s.parent ? ' from ' + s.parent + ' (' + s.reason + ')' : ' (start)') + ' · ' + s.turn + ' turns · ' + s.records + ' records' + (s.handoff ? ' · handed off at ' + short(s.handoff.tokensBefore) + ' tokens → ' + s.handoff.to : '') + (s.coverage !== 'complete' ? ' · coverage: ' + s.coverage : '') + (s.raw?.ok ? ' · raw JSONL: ' + s.raw.path : ''))
  }
  if (thread.notes?.length) {
    lines.push('Notes:')
    for (const n of thread.notes.slice(-20)) lines.push('- ' + n.text + ' (' + n.s + ')')
  }
  lines.push('')
  lines.push('Turns ' + (end - page.length + 1) + '-' + end + ' of ' + turns.length + ' (oldest first):')
  for (const t of page) {
    lines.push(t.s + ' T' + t.t + ' ' + clockTime(t.time) + ' r' + t.r0 + '-r' + t.r1 + ' · ' + (t.ask ? '"' + t.ask + '"' : '(no prompt)') + (t.files.length ? ' · edited ' + t.files.slice(0, 4).join(', ') + (t.files.length > 4 ? ' +' + (t.files.length - 4) : '') : '') + (t.errors ? ' · ' + t.errors + ' errors' : ''))
  }
  if (end - page.length > 0) lines.push('Earlier turns: call again with cursor=' + (skip + page.length) + '.')
  lines.push('Read a turn: history_read ref="S1 T12". Find something: history_search query="...".')
  return lines.join('\n')
}

async function toolSearch($, e) {
  if (!thread) return noArchive()
  await loadRecords($)
  const res = searchRecords(records, { query: e.query, mode: e.mode, kind: e.kind, tool: e.tool_name, session: e.session, limit: e.limit, cursor: e.cursor })
  if (res.error) return 'Search error: ' + res.error
  if (!res.total) return 'No match for "' + e.query + '" in ' + (thread.nextN - 1) + ' records. Try fewer or different words, mode="literal" for an exact phrase, or history_index for an overview.'
  const lines = [res.total + ' match' + (res.total === 1 ? '' : 'es') + ' for "' + e.query + '" (prompts and replies first, then newest):']
  for (const h of res.hits) lines.push('r' + h.n + ' ' + h.s + ' T' + h.t + ' ' + h.kind + ' (' + h.size + ' chars): ' + h.snippet)
  if (res.nextCursor !== null) lines.push('More: call again with cursor=' + res.nextCursor + '.')
  lines.push('Read one in full: history_read ref="r<n>" (around=2 adds neighbours).')
  return lines.join('\n')
}

async function toolRead($, e) {
  if (!thread) return noArchive()
  await loadRecords($)
  // models sometimes guess the argument's name; take the obvious ones
  const sel = parseRef(e.ref ?? e.record ?? e.turn ?? e.id ?? e.file_path, session?.key)
  if (!sel) return 'ref must look like "r340", "S2 T7", "S2 T7-T9" or "S2".'
  const out = readRecords(records, sel, { around: Math.min(10, Math.max(0, Number(e.around) || 0)), maxChars: Math.min(60_000, Math.max(2000, Number(e.max_chars) || 12_000)), offset: Math.max(0, Number(e.offset) || 0) })
  if (!out.count) return 'Nothing archived at ' + e.ref + '.'
  return out.text + (out.more !== null ? '[' + (out.count - out.more) + ' more records: call again with offset=' + out.more + ']' : '')
}

async function toolNote($, e) {
  const text = String(e.text ?? '').trim()
  if (!text) return 'text is empty'
  await ensureThread($)
  thread.notes = [...(thread.notes ?? []), { text: text.slice(0, 600), s: session.key, at: await nowIso($) }].slice(-60)
  await saveManifest($)
  return 'Noted. Every later session of this thread sees it in its handoff card.'
}

// ---------------------------------------------------------------- the view model

async function viewModel($, columns) {
  const turns = thread && recordsLoaded ? turnIndex(records) : []
  return {
    columns,
    settings,
    unattended: isUnattended(),
    unattendedForced: !!ctx?.envUnattended,
    limitFromEnv: ctx?.envLimit > 0,
    compactAt,
    cappedByCompaction: !(ctx?.envLimit > 0) && compactAt > 0 && currentLimit() < handoffLimit(settings, usageNow.window || 200_000),
    floor: floor ?? 0,
    grown: grewEnough(usageNow.tokens, floor ?? 0, currentLimit()),
    asking,
    snoozeUntil,
    tokens: usageNow.tokens,
    window: usageNow.window,
    percent: usageNow.percent,
    limit: currentLimit(),
    level: levelOf(usageNow.tokens, currentLimit()),
    phase,
    failure,
    pendingCard: pending && pending.sid === sid ? pending : null,
    offerThread,
    threadId: thread?.id ?? null,
    sessionKey: session?.key ?? 'S1',
    sessions: thread?.sessions ?? [],
    sessionsCount: thread?.sessions.length ?? 1,
    totalRecords: thread ? thread.nextN - 1 : 0,
    totalTurns: thread ? thread.sessions.reduce((n, s) => n + (s.turn ?? 0), 0) : 0,
    archiveBytes: thread ? thread.sessions.reduce((n, s) => n + (s.bytes ?? 0), 0) : 0,
    archiveDir: ctx ? (thread ? threadDir() : ctx.base) : null,
    coverage: thread && thread.sessions.some((s) => s.coverage !== 'complete') ? 'partial: ' + thread.sessions.filter((s) => s.coverage !== 'complete').map((s) => s.key + ' ' + s.coverage).join('; ') : 'complete',
    rawText: thread ? thread.sessions.filter((s) => s.raw?.ok).length + ' of ' + thread.sessions.length + ' session transcripts copied' + (thread.sessions.some((s) => s.raw && !s.raw.ok) ? ' (last error: ' + thread.sessions.filter((s) => s.raw && !s.raw.ok).map((s) => s.raw.note).pop() + ')' : '') : 'copied at each handoff',
    rawOk: thread ? !thread.sessions.some((s) => s.raw && !s.raw.ok) : true,
    lastWrite,
    stats: stats(),
    handoffs: stats().handoffs.length,
    tab,
    searchResult,
    turns,
  }
}

function makeActions($) {
  return {
    handoff: () => scheduleHandoff($, { reason: 'manual' }),
    handoffContinue: () => scheduleHandoff($, { reason: 'manual', continueText: CONTINUE_TEXT }),
    archiveNow: async () => {
      try {
        const n = await archiveNow($, 'manual')
        if (thread && session) { await copyRaw($, session); await saveManifest($) }
        $.ui.toast('Archived ' + n + ' new record' + (n === 1 ? '' : 's') + ' and copied the raw transcript.')
      } catch (err) {
        $.ui.toast('Archive failed: ' + String(err?.message ?? err))
      }
      $.ui.invalidate('ui.render')
    },
    copyPath: async () => {
      if (!ctx) return
      try { await $.ui.copy({ text: thread ? threadDir() : ctx.base }) } catch {}
      $.ui.toast('Archive folder path copied.')
    },
    openPane: () => $.ui.open({ id: PANE, title: 'Session Transfer', focus: true, closeOnEscape: true }),
    setTab: (t) => { tab = t; $.ui.invalidate('ui.render') },
    setSetting: async (key, value) => {
      settings = normalizeSettings({ ...settings, [key]: value })
      try { await $.store.set('settings', settingsOverrides(settings)) } catch {} // later default changes still apply
      $.ui.invalidate('ui.render')
    },
    search: async (q) => {
      const query = String(q ?? '').trim()
      if (!query) return
      if (!thread) { searchResult = { query, error: 'Nothing archived yet.' }; $.ui.invalidate('ui.render'); return }
      await loadRecords($)
      searchResult = { query, ...searchRecords(records, { query, limit: 8 }) }
      $.ui.invalidate('ui.render')
    },
    clearSearch: () => { searchResult = null; $.ui.invalidate('ui.render') },
    attachThread: async () => { await attachThread($); $.ui.invalidate('ui.render') },
    ignoreThread: () => { offerThread = null; $.ui.invalidate('ui.render') },
    dismiss: () => { failure = null; $.ui.invalidate('ui.render') },
    toggleUnattended: async () => { if (!ctx?.envUnattended) await setUnattended($, !isUnattended()) },
    suggest: () => { suggestHandoff($, false) },
  }
}

// ---------------------------------------------------------------- hooks

export function register(on) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await loadSettings($)
    try {
      await bindSession($, 'startup')
      await recoverOp($)
    } catch (err) {
      $.ui.log('session-transfer: ' + err.message, { to: 'debug' })
    }
    await refreshUsage($)
    try {
      await $.command.register({ name: 'transfer', description: 'Open the session-transfer panel; "unattended on|off" swaps without asking in this session', argumentHint: '[unattended on|off]', immediate: true })
      await $.command.register({ name: 'handoff', description: 'Move this work to a fresh session now; the full history stays searchable', argumentHint: '[continue | <message for the fresh session>]', immediate: true })
      await $.tool.register({
        name: 'history_index',
        description: 'Overview of this work thread across sessions that session-transfer handed off: sessions, notes, and one line per turn (what was asked, files edited). Call it first when the user asks what was done so far. Pages with cursor.',
        inputSchema: { type: 'object', properties: { session: { type: 'string', description: '"S2", or "all" (default)' }, limit: { type: 'integer', description: 'turns per page, default 40' }, cursor: { type: 'integer', description: 'turns to skip from the newest end' } } },
        isDeferred: true,
      })
      await $.tool.register({
        name: 'history_search',
        description: 'Search the archived history of this work thread (every prompt, reply, tool call and tool result of earlier sessions). Returns record refs with snippets.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'words (all must match), an exact phrase with mode=literal, or a regex with mode=regex' },
            mode: { type: 'string', enum: ['words', 'literal', 'regex'] },
            kind: { type: 'string', enum: ['any', 'user', 'assistant', 'tool', 'result'] },
            tool_name: { type: 'string', description: 'only calls/results of this tool, e.g. Bash' },
            session: { type: 'string', description: '"S1", or "all" (default)' },
            limit: { type: 'integer', description: 'default 10, max 50' },
            cursor: { type: 'integer' },
          },
          required: ['query'],
        },
        isDeferred: true,
      })
      await $.tool.register({
        name: 'history_read',
        description: 'Read archived records in full: one record ("r340", with around=N for neighbours), a turn ("S2 T7"), a range ("S2 T7-T9") or a session ("S1"). Pages with offset.',
        inputSchema: { type: 'object', properties: { ref: { type: 'string' }, around: { type: 'integer' }, max_chars: { type: 'integer', description: 'default 12000, max 60000' }, offset: { type: 'integer' } }, required: ['ref'] },
        isDeferred: true,
      })
      await $.tool.register({
        name: 'history_note',
        description: 'Save a short durable note (a decision, constraint, or where something lives) to this work thread. Every later session sees the notes in its handoff card.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        isDeferred: true,
      })
    } catch (err) {
      $.ui.log('session-transfer: could not register commands/tools: ' + (err?.message ?? err), { to: 'debug' })
    }
    return result
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const result = await next(e)
    if (e.transcript_path && e.session_id) transcriptPaths[e.session_id] = e.transcript_path
    try { await bindSession($, e.source) } catch {}
    await refreshUsage($)
    $.ui.invalidate('ui.render')
    return result
  }).catch(async ($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    if (e.transcript_path && e.session_id) transcriptPaths[e.session_id] = e.transcript_path
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) turnRunning = true
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      if (!e.agentId && r?.usage) onRequest(r.usage)
    } catch {}
    return r
  })

  // Our own lookup tools: answered here, never reaching the engine.
  on('tool.call', { tool: 'mcp__session-transfer__history_index' }, async ($, e) => {
    const text = await toolIndex($, e)
    countLookup(text)
    return { result: text }
  }).catch(async () => ({ result: 'The history lookup failed. Retry once, or Grep the archive folder named in the handoff card (records start with "@@ r").' }))
  on('tool.call', { tool: 'mcp__session-transfer__history_search' }, async ($, e) => {
    const text = await toolSearch($, e)
    countLookup(text)
    return { result: text }
  }).catch(async () => ({ result: 'The history lookup failed. Retry once, or Grep the archive folder named in the handoff card (records start with "@@ r").' }))
  on('tool.call', { tool: 'mcp__session-transfer__history_read' }, async ($, e) => {
    const text = await toolRead($, e)
    countLookup(text)
    return { result: text }
  }).catch(async () => ({ result: 'The history lookup failed. Retry once, or Grep the archive folder named in the handoff card (records start with "@@ r").' }))
  on('tool.call', { tool: 'mcp__session-transfer__history_note' }, async ($, e) => {
    const text = await toolNote($, e)
    return { result: text }
  }).catch(async () => ({ result: 'The history lookup failed. Retry once, or Grep the archive folder named in the handoff card (records start with "@@ r").' }))

  // Context telemetry: near the limit, Claude reads its own context size after
  // a tool result (mainplane appends "context N" to every result), so it can
  // reach a clean stopping point before the handoff.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || !settings.telemetry || settings.mode === 'off' || !r || r.deny) return r
    await refreshUsage($)
    const limit = currentLimit()
    const level = levelOf(usageNow.tokens, limit)
    noteState.calls += 1
    const changed = level !== noteState.level
    noteState.level = level
    if (!noteDue(level, noteState.calls, changed)) return r
    noteState.calls = 0
    if (level === 'armed') stopRequested = true
    const note = telemetryNote({ tokens: usageNow.tokens, limit, sessionKey: session?.key ?? 'S1', unattended: isUnattended(), autoContinue: settings.autoContinue })
    return note ? { ...r, context: [...(r.context ?? []), note] } : r
  }).catch(async ($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    turnRunning = false
    await refreshUsage($)
    try {
      await archiveNow($, 'turn')
    } catch (err) {
      $.ui.log('session-transfer: archive failed: ' + (err?.message ?? err), { to: 'debug' })
    }
    const level = levelOf(usageNow.tokens, currentLimit())
    const stopped = stopRequested && e.reason === 'answer'
    if (handoffRequested) {
      const opts = handoffRequested
      handoffRequested = null // the slot stays reserved (handoffBusy) for this run
      $.clock.after(20, () => { handoff($, opts) })
    } else if (lastWrite?.ok) {
      const action = limitAction({ level, mode: settings.mode, unattended: isUnattended(), autoContinue: settings.autoContinue, stopped, tokens: usageNow.tokens, snoozeUntil, canAsk: !asking && !handoffBusy, floor: floor ?? 0, limit: currentLimit() })
      if (action === 'swap-continue') scheduleHandoff($, { reason: 'limit', continueText: CONTINUE_TEXT })
      else if (action === 'arm' || action === 'wait') armed = true
      else if (action === 'suggest') {
        armed = true
        $.clock.after(20, () => { suggestHandoff($, stopped) })
      }
    }
    stopRequested = false
    $.ui.invalidate('ui.render')
    return result
  })

  // The card's main road: a context block on the fresh conversation's first
  // user message, like CLAUDE.md. prompt.submit below is the fallback; the
  // first of the two to run delivers it, once.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!pending) return result
    const id = await $.session.id()
    if (pending.sid !== id) return result
    const card = pending.card
    await delivered($)
    $.ui.invalidate('ui.render')
    return { ...result, blocks: [...(result?.blocks ?? e.blocks ?? []), { name: 'sessionTransfer', text: card }] }
  }).catch(async ($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (pending) {
      const id = await $.session.id()
      if (pending.sid === id) {
        const card = pending.card
        await delivered($)
        offerThread = null
        $.ui.invalidate('ui.render')
        return next({ ...e, context: [...(e.context ?? []), card] })
      }
    }
    offerThread = null
    const kind = e.origin?.kind
    // Only an unattended session moves a prompt without asking; a supervised one was asked at turn end.
    if (armed && isUnattended() && settings.mode !== 'off' && !handoffBusy && !e.turnId && kind && kind !== 'plugin' && !(e.attachments?.length) && lastWrite?.ok) {
      await refreshUsage($)
      armed = levelOf(usageNow.tokens, currentLimit()) === 'armed'
      if (!armed || !scheduleHandoff($, { reason: 'limit', resubmit: e.text })) return next(e)
      armed = false
      return { drop: 'session-transfer: the context reached its handoff limit, so this message goes to a fresh session. The full history stays searchable there.' }
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // Compaction: hand off in place instead of paying for a summary.
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (e.trigger === 'precompute') {
      if (settings.mode !== 'off' && settings.replaceCompaction) {
        stats().precomputeSkipped = (stats().precomputeSkipped ?? 0) + 1
        return { skip: 'session-transfer hands off instead of compacting' }
      }
      return next(e)
    }
    let archived = false
    try {
      await runQueued(() => archiveMessages($, e.messages, 'compact'))
      archived = true
    } catch (err) {
      lastWrite = { time: await nowIso($), ok: false, error: String(err?.message ?? err) }
    }
    if (archived && e.trigger === 'auto' && settings.mode !== 'off' && settings.replaceCompaction) {
      try {
        await copyRaw($, session)
        const tokensBefore = usageNow.tokens || Math.round(e.messages.reduce((n, m) => n + messageChars(m), 0) / CHARS_PER_TOKEN)
        const card = await makeCard($, { toKey: session.key, emergency: true })
        const { messages } = emergencyMessages(e.messages, card)
        const st = thread.stats
        st.handoffs = [...st.handoffs, { kind: 'emergency', from: session.key, to: session.key, at: await nowIso($), tokensBefore, cardTokens: tokensOf(card), firstPrompt: null, requestsAfter: 0, reason: 'auto-compact' }]
        st.marks = [...st.marks, st.samples.length]
        session.cursor = nextCursor(session.cursor, messages, messages)
        await saveManifest($)
        const tokensAfter = Math.round(messages.reduce((n, m) => n + messageChars(m), 0) / CHARS_PER_TOKEN)
        usageNow = { ...usageNow, tokens: tokensAfter }
        $.ui.invalidate('ui.render')
        return { messages, tokensBefore, tokensAfter }
      } catch (err) {
        $.ui.log('session-transfer: in-place handoff failed, the engine compacts instead: ' + (err?.message ?? err), { to: 'debug' })
        return next(e)
      }
    }
    if (archived && e.trigger === 'manual') {
      const hint = 'The full pre-compaction history is archived by session-transfer. Say in the summary that it can be searched with mcp__session-transfer__history_search and read with history_read.'
      return next({ ...e, instructions: (e.instructions ? e.instructions + '\n\n' : '') + hint })
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('command.run', { command: 'transfer' }, async ($, e) => {
    const m = /^unattended(?:\s+(on|off))?$/i.exec(String(e.args ?? '').trim())
    if (m) {
      await ensureCtx($)
      if (ctx.envUnattended) return { text: 'Unattended is forced on for this process by SESSION_TRANSFER_UNATTENDED=1.' }
      const enable = m[1] ? m[1].toLowerCase() === 'on' : !isUnattended()
      await setUnattended($, enable)
      return {
        text: enable
          ? 'Unattended is on for this session: at the limit it swaps to a fresh session without asking, and continues by itself when Claude stops for the limit.'
          : 'Unattended is off: at the limit you are asked yes/no before any swap.',
      }
    }
    await $.ui.open({ id: PANE, title: 'Session Transfer', focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (settings.mode === 'off') return { text: 'session-transfer is off. Turn it on in /transfer → Settings.' }
    const args = String(e.args ?? '').trim()
    if (/^continue$/i.test(args)) scheduleHandoff($, { reason: 'manual', continueText: CONTINUE_TEXT })
    else if (args) scheduleHandoff($, { reason: 'manual', resubmit: args })
    else scheduleHandoff($, { reason: 'manual' })
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !settings.showBand) return next(e)
    const el = $.ui.resolve(e)
    const ours = band(el, await viewModel($, e.props.bodyColumns ?? 100), makeActions($))
    if (!ours) return next(e)
    const theirs = await next(e)
    return el.Box({ flexDirection: 'column', children: theirs ? [ours, theirs] : [ours] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    if (thread && !recordsLoaded) await loadRecords($)
    return pane($.ui.resolve(e), await viewModel($, e.props.bodyColumns ?? 80), makeActions($))
  })
}

const ARCHIVE_README = `# session-transfer archive

One folder per project. Each thread is a chain of Claude Code sessions that
continue one piece of work: threads/<thread>/

  thread.json          the manifest: sessions (S1, S2, ...), handoffs, notes, stats
  S<k>-<session8>/     immutable chunk files, one per flush
  raw/<session>.jsonl  copies of Claude Code's own transcripts, taken at handoff

A chunk is plain text. Each record is one header line, then exactly len
characters of body:

  @@ r<n> <kind> S<k> T<turn> <time> [id=<tool_use_id>] len=<chars>

kind is user, assistant, tool:<Name> or result:<Name> (a trailing ! marks an
error). Search with the history_search tool, or rg -n over the folder: the
header of a line is the nearest line above it that starts with "@@ r".
`
