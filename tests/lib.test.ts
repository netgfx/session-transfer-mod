import { expect, test } from 'claude-code/testing'
import {
  normalizeSettings, handoffLimit, levelOf, fingerprint, newMessages, nextCursor, toRecords, formatRecord, parseChunk,
  buildChunks, turnIndex, searchRecords, parseRef, readRecords, buildCard, emergencyMessages, telemetryNote, noteDue,
  addRequest, emptyStats, savings, gauge, sparkline, projectSlug, joinPath, nextSessionKey, psQuote, limitAction, snoozeAfterNo, suggestQuestion, grewEnough, CHUNK_MAX_BYTES, PART_CHARS, MESSAGES_CAP, utf8Bytes, mergeParts, lineageRecords, splitBody,
} from '../hooks/lib.js'

const user = (text: string) => ({ role: 'user', text, toolUses: [] })
const asst = (text: string, toolUses: any[] = []) => ({ role: 'assistant', text, toolUses })
const use = (id: string, tool: string, input: any, text?: string, isError?: boolean) => ({ tool_use_id: id, tool, input, text, ...(isError ? { isError: true } : {}) })

test('settings normalize and the limit takes the smaller of percent and cap', async () => {
  const s = normalizeSettings({ mode: 'weird', thresholdPct: 500, capTokens: 0 })
  expect(s.mode).toBe('auto')
  expect(s.thresholdPct).toBe(95)
  expect(s.capTokens).toBe(0)
  expect(handoffLimit(normalizeSettings({ thresholdPct: 60, capTokens: 160_000 }), 200_000)).toBe(120_000)
  expect(handoffLimit(normalizeSettings({ thresholdPct: 60, capTokens: 160_000 }), 1_000_000)).toBe(160_000)
  expect(handoffLimit(normalizeSettings({ thresholdPct: 50, capTokens: 0 }), 1_000_000)).toBe(500_000)
  expect(levelOf(50, 100)).toBe('ok')
  expect(levelOf(70, 100)).toBe('filling')
  expect(levelOf(90, 100)).toBe('near')
  expect(levelOf(100, 100)).toBe('armed')
})

test('records survive a round trip byte for byte, even with header-like text and CRLF in bodies', async () => {
  const tricky = 'line one\r\n@@ r999 user S9 T9 - len=3\nabc\r\n\n@@ r1000 assistant S9 T9 - len=1\nx'
  const { records } = toRecords(
    [user('fix the bug'), asst('looking', [use('t1', 'Bash', { command: 'cat x' }, tricky), use('t2', 'Edit', { file_path: 'C:\\w\\a.js' }, 'boom', true)]), asst('done')],
    { startN: 5, sessionKey: 'S2', time: '2026-11-01T10:00:00.000Z' },
  )
  expect(records.map((r: any) => r.n)).toEqual([5, 6, 7, 8, 9, 10, 11])
  const text = records.map(formatRecord).join('')
  const back = parseChunk(text)
  expect(back.length).toBe(7)
  expect(back[3].body).toBe(tricky)
  expect(back[3].kind).toBe('result')
  expect(back[3].tool).toBe('Bash')
  expect(back[5].err).toBe(true)
  expect(back[0].s).toBe('S2')
  expect(back[0].t).toBe(1)
})

test('chunks split by UTF-8 bytes; a huge body becomes parts, never cut', async () => {
  const cjk = '漢'.repeat(900_000) // 3 bytes each: 2.7 MB in one record
  const huge = 'y'.repeat(PART_CHARS * 2 + 5)
  const { records } = toRecords([user('a'), asst(cjk), asst(cjk), asst(huge)], { sessionKey: 'S1' })
  const chunks = buildChunks(records, { thread: 't', s: 'S1', sid: 'abc', time: 'now' })
  for (const c of chunks) expect(utf8Bytes(c.text)).toBeLessThan(CHUNK_MAX_BYTES + 4096)
  const merged = mergeParts(chunks.flatMap((c: any) => parseChunk(c.text)))
  expect(merged.map((r: any) => r.n)).toEqual([1, 2, 3, 4])
  expect(merged[1].body).toBe(cjk)
  expect(merged[3].body).toBe(huge)
  const emoji = '😀'.repeat(10) // surrogate pairs are never split across parts
  const parts = splitBody(emoji, 3)
  expect(parts.join('')).toBe(emoji)
  expect(parts.every((p: string) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true)
})

test('the cursor is positional: repeated identical exchanges are never dropped', async () => {
  const a = [user('go'), asst('ok')]
  const c1 = nextCursor(null, a, a)
  const b = [...a, user('go'), asst('ok')]
  const r = newMessages(b, c1)
  expect(r.gap).toBe(false)
  expect(r.fresh.length).toBe(2)
  const c2 = nextCursor(c1, r.fresh, b)
  expect(newMessages(b, c2).fresh.length).toBe(0)
})

test('a tool result that lands after a flush is archived when it lands', async () => {
  const early = [user('run it'), asst('', [use('x', 'Bash', { command: 'make' })])]
  const c1 = nextCursor(null, early, early)
  const later = [user('run it'), asst('', [use('x', 'Bash', { command: 'make' }, 'built ok')])]
  const r = newMessages(later, c1)
  expect(r.fresh.length).toBe(1)
  expect(r.fresh[0].toolUses[0].text).toBe('built ok')
})

test('after compaction the cursor reports a gap and skips what it has seen', async () => {
  const msgs = [user('go'), asst('ok'), user('more'), asst('sure')]
  const cursor = nextCursor(null, msgs, msgs)
  const compacted = [user('summary of everything'), asst('sure'), user('next'), asst('fine')]
  const { fresh, gap } = newMessages(compacted, { fps: [fingerprint(user('gone'))], seen: cursor.seen, count: 4 })
  expect(gap).toBe(true)
  expect(fresh.map((m: any) => m.text)).toEqual(['summary of everything', 'next', 'fine'])
})

test('a first snapshot at the 4096-entry window is reported as a gap', async () => {
  const full = Array.from({ length: MESSAGES_CAP }, (_, i) => (i % 2 ? asst('a' + i) : user('u' + i)))
  expect(newMessages(full, null).gap).toBe(true)
  expect(newMessages(full.slice(0, 10), null).gap).toBe(false)
})

test('cards speak from their own lineage: no sibling branch, nothing past a fork', async () => {
  const recs = [
    { n: 1, s: 'S1', kind: 'user', body: 'base' }, { n: 2, s: 'S1', kind: 'user', body: 's1 after fork' },
    { n: 3, s: 'S2', kind: 'user', body: 'sibling work' }, { n: 4, s: 'S3', kind: 'user', body: 'branch work' },
  ]
  const sessions = [{ key: 'S1', parent: null }, { key: 'S2', parent: 'S1' }, { key: 'S3', parent: 'S1', forkAt: 2 }]
  expect(lineageRecords(recs, sessions, 'S1').map((r: any) => r.n)).toEqual([1, 2])
  expect(lineageRecords(recs, sessions, 'S2').map((r: any) => r.n)).toEqual([1, 2, 3])
  expect(lineageRecords(recs, sessions, 'S3').map((r: any) => r.n)).toEqual([1, 4])
})

test('the turn index names asks, edited files and errors', async () => {
  const { records } = toRecords([
    user('add login\nwith details'), asst('', [use('a', 'Write', { file_path: 'src/login.js', content: '' }, 'ok'), use('b', 'Bash', { command: 'npm test' }, 'fail', true)]),
    user('now logout'), asst('done'),
  ], { sessionKey: 'S1' })
  const idx = turnIndex(records)
  expect(idx.length).toBe(2)
  expect(idx[0].ask).toBe('add login')
  expect(idx[0].files).toEqual(['src/login.js'])
  expect(idx[0].errors).toBe(1)
  expect(idx[1].t).toBe(2)
})

test('search: words, literal, regex, filters, paging', async () => {
  const { records } = toRecords([
    user('why does the Auth token expire'), asst('The JWT expiry is 15 minutes', [use('a', 'Grep', { pattern: 'expiresIn' }, 'src/auth.ts:12 expiresIn: "15m"')]),
    user('raise it to an hour'), asst('Done: expiresIn is now 1h'),
  ], { sessionKey: 'S1' })
  const w = searchRecords(records, { query: 'expir token' })
  expect(w.total).toBe(1)
  expect(w.hits[0].kind).toBe('user')
  const l = searchRecords(records, { query: 'expiresIn: "15m"', mode: 'literal' })
  expect(l.total).toBe(1)
  expect(l.hits[0].kind).toBe('result:Grep')
  const r = searchRecords(records, { query: 'expires?In', mode: 'regex', kind: 'assistant' })
  expect(r.total).toBe(1)
  expect(searchRecords(records, { query: '(', mode: 'regex' }).error).toMatch(/bad regex/)
  const p = searchRecords(records, { query: 'expir', limit: 1 })
  expect(p.hits.length).toBe(1)
  expect(p.nextCursor).toBe(1)
  expect(searchRecords(records, { query: 'expir', tool: 'grep' }).total).toBe(2)
})

test('refs and budgeted reads page through long turns', async () => {
  expect(parseRef('r12', 'S1')).toEqual({ n: 12 })
  expect(parseRef('S2 T7', 'S1')).toEqual({ s: 'S2', t0: 7, t1: 7 })
  expect(parseRef('t3-5', 'S4')).toEqual({ s: 'S4', t0: 3, t1: 5 })
  expect(parseRef('S3', 'S1')).toEqual({ s: 'S3' })
  expect(parseRef('nonsense', 'S1')).toBe(null)
  const { records } = toRecords([user('q'), asst('a'.repeat(5000)), asst('b'.repeat(5000)), asst('c'.repeat(5000))], { sessionKey: 'S1' })
  const first = readRecords(records, { s: 'S1', t0: 1, t1: 1 }, { maxChars: 8000 })
  expect(first.more).not.toBe(null)
  const rest = readRecords(records, { s: 'S1', t0: 1, t1: 1 }, { maxChars: 8000, offset: first.more })
  expect(rest.text).toMatch(/c{100}/)
  const one = readRecords(records, { n: 3 }, { around: 1 })
  expect(one.count).toBe(3)
})

test('the card routes to the archive and states where the work stopped', async () => {
  const { records } = toRecords([
    user('build the exporter'), asst('', [use('a', 'TodoWrite', { todos: [{ content: 'parse input', status: 'completed' }, { content: 'write CSV', status: 'in_progress' }] }, 'ok'), use('b', 'Edit', { file_path: 'D:\\w\\src\\export.ts' }, 'ok')]),
    user('also add JSON output'), asst('CSV works; JSON next'),
  ], { sessionKey: 'S1' })
  const card = buildCard({ thread: 't1', fromKey: 'S1', toKey: 'S2', archiveDir: 'C:/a', totalRecords: records.length, sessions: 1, records, cwd: 'D:\\w', firstAsk: 'build the exporter', notes: [{ text: 'use papaparse', s: 'S1' }], branch: 'main' })
  expect(card).toMatch(/^<session-transfer-handoff thread="t1" from="S1" to="S2">/)
  expect(card).toMatch(/history_index/)
  expect(card).toMatch(/history_search/)
  expect(card).toMatch(/Last user request \(S1 T2, r\d+\): "also add JSON output"/)
  expect(card).toMatch(/\[~\] write CSV/)
  expect(card).toMatch(/\[x\] parse input/)
  expect(card).toMatch(/src\/export\.ts/)
  expect(card).toMatch(/use papaparse/)
  expect(card).toMatch(/git branch main/)
  expect(card.length).toBeLessThan(4000)
  const resub = buildCard({ thread: 't1', fromKey: 'S1', toKey: 'S2', archiveDir: 'C:/a', totalRecords: 1, sessions: 1, records, resubmitted: true })
  expect(resub).not.toMatch(/Last user request/)
  expect(resub).toMatch(/forwarded here unchanged/)
})

test('emergency reduction keeps the current turn with handles when it fits', async () => {
  const msgs = [user('old'), asst('old reply'), user('current task'), { ...asst('', [use('a', 'Bash', { command: 'ls' }, 'x')]), handle: 'h1' }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'x', isError: false }], handle: 'h2' }]
  const fit = emergencyMessages(msgs, 'CARD', 10_000)
  expect(fit.keptTail).toBe(2)
  expect(fit.messages[0].text).toMatch(/^CARD[\s\S]*current task$/)
  expect(fit.messages[1].handle).toBe('h1')
  const tight = emergencyMessages(msgs, 'CARD', 1)
  expect(tight.messages.length).toBe(1)
  const bounded = emergencyMessages([user('x'.repeat(50_000))], 'CARD', 80_000, 8_000)
  expect(bounded.messages[0].text.length).toBeLessThan(8_400)
  expect(bounded.messages[0].text).toMatch(/42000 more chars/)
})

test('telemetry speaks only near the limit, and sparingly', async () => {
  expect(telemetryNote({ tokens: 10, limit: 100, sessionKey: 'S1', unattended: false, autoContinue: true })).toBe(null)
  const near = telemetryNote({ tokens: 90, limit: 100, sessionKey: 'S1', unattended: false, autoContinue: true })
  expect(near).toMatch(/No action is needed/)
  // supervised: informs, never commands, never promises a swap the person has not approved
  const supervised = telemetryNote({ tokens: 120, limit: 100, sessionKey: 'S1', unattended: false, autoContinue: true })
  expect(supervised).toMatch(/the user will be offered a fresh session/)
  for (const note of [near, supervised]) {
    expect(note).toMatch(/^Context status from session-transfer, a Claude Code plugin the user installed:/) // attributed, so it isn't read as an injection
    expect(note).not.toMatch(/automatically|end your turn|must|stop now/i)
  }
  const unattended = telemetryNote({ tokens: 120, limit: 100, sessionKey: 'S1', unattended: true, autoContinue: true })
  expect(unattended).toMatch(/The user set this session to run unattended, so when this turn ends it continues in a fresh session/)
  expect(telemetryNote({ tokens: 120, limit: 100, sessionKey: 'S1', unattended: true, autoContinue: false })).toMatch(/the user will be offered a fresh session/)
  expect(noteDue('ok', 50, true)).toBe(false)
  expect(noteDue('near', 1, true)).toBe(true)
  expect(noteDue('near', 3, false)).toBe(false)
  expect(noteDue('armed', 3, false)).toBe(true)
})

test('the limit decision: unattended has priority; otherwise nothing swaps without asking', async () => {
  const at = { level: 'armed', tokens: 130_000, snoozeUntil: 0, canAsk: true, autoContinue: true, stopped: false }
  // every combination of mode x unattended x stopped
  const table: [string, boolean, boolean, string][] = [
    ['auto', false, false, 'suggest'], ['auto', false, true, 'suggest'],
    ['manual', false, false, 'wait'], ['manual', false, true, 'wait'],
    ['off', false, true, 'none'], ['off', true, true, 'none'],
    ['auto', true, false, 'arm'], ['auto', true, true, 'swap-continue'],
    ['manual', true, false, 'arm'], ['manual', true, true, 'swap-continue'],
  ]
  for (const [mode, unattended, stopped, want] of table) {
    expect([mode, unattended, stopped, limitAction({ ...at, mode, unattended, stopped })]).toEqual([mode, unattended, stopped, want])
  }
  // no swap of any kind below the limit
  for (const level of ['ok', 'filling', 'near']) expect(limitAction({ ...at, level, mode: 'auto', unattended: true, stopped: true })).toBe('none')
  // a "no" holds until the context grows past the snooze; a dialog already open is not stacked
  expect(limitAction({ ...at, mode: 'auto', unattended: false, snoozeUntil: 148_000 })).toBe('wait')
  expect(limitAction({ ...at, mode: 'auto', unattended: false, tokens: 150_000, snoozeUntil: 148_000 })).toBe('suggest')
  expect(limitAction({ ...at, mode: 'auto', unattended: false, canAsk: false })).toBe('wait')
  // unattended without autoContinue never sends a continuation on its own
  expect(limitAction({ ...at, mode: 'auto', unattended: true, stopped: true, autoContinue: false })).toBe('arm')
  // a session over the limit only because of its own first prompt never swaps (unattended would loop)
  expect(limitAction({ ...at, mode: 'auto', unattended: true, stopped: true, tokens: 53_000, floor: 52_000, limit: 30_000 })).toBe('none')
  expect(limitAction({ ...at, mode: 'auto', unattended: false, tokens: 53_000, floor: 52_000, limit: 30_000 })).toBe('none')
  expect(limitAction({ ...at, mode: 'auto', unattended: true, stopped: true, tokens: 57_000, floor: 52_000, limit: 30_000 })).toBe('swap-continue')
  expect(grewEnough(130_000, 47_000, 120_000)).toBe(true)
  expect(grewEnough(130_000, 125_000, 120_000)).toBe(false) // 5k < 10% of 120k
  expect(snoozeAfterNo(130_000, 120_000)).toBe(148_000)
  const q = suggestQuestion({ tokens: 130_000, limit: 120_000, sessionKey: 'S2', continueTask: true })
  expect(q.question).toMatch(/\?/)
  expect([q.yes, q.no]).toEqual(['Yes, swap and continue', 'No, stay here'])
  expect(normalizeSettings({ mode: 'ask' }).mode).toBe('manual')
})

test('stats and savings are computed from usage, with estimates kept apart', async () => {
  let st = emptyStats()
  st = addRequest(st, { input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 2_000, output_tokens: 500 })
  st = { ...st, handoffs: [{ kind: 'handoff', tokensBefore: 152_010, firstPrompt: 12_000, cardTokens: 900, requestsAfter: 10 }, { kind: 'emergency', tokensBefore: 190_000, cardTokens: 800, requestsAfter: 0 }] }
  const s = savings(st)
  expect(s.requests).toBe(1)
  expect(s.handoffs).toBe(1)
  expect(s.emergencies).toBe(1)
  expect(s.rereadAvoided).toBe((152_010 - 12_000) * 10)
  expect(s.summarizerAvoided).toBe(190_000)
  expect(s.cacheHitPct).toBe(99)
})

test('drawing helpers and paths', async () => {
  expect(gauge(50, 100, 60, 10)).toBe('█████░│░░░')
  expect(sparkline([1, 2, 3, 4], 4, [2])).toBe("▂▄│█")
  expect(projectSlug('D:\\Projects\\a b')).toBe('D--Projects-a-b')
  expect(joinPath('C:\\Users\\me\\.claude', 'session-transfer', 'x')).toBe('C:\\Users\\me\\.claude\\session-transfer\\x')
  expect(joinPath('/Users/me/.claude/', '/session-transfer')).toBe('/Users/me/.claude/session-transfer')
  expect(nextSessionKey({ sessions: [{ key: 'S1' }, { key: 'S3' }] })).toBe('S4')
  expect(psQuote("it's")).toBe("'it''s'")
})
