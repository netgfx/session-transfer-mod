import { expect, test, mock } from 'claude-code/testing'

type Answer = 'yes' | 'no' | 'dismiss' | 'nobody'
type Opts = {
  os?: 'windows' | 'mac'
  tokens?: number
  window?: number
  settings?: any
  compactAt?: number // Claude Code's auto-compaction point, as /context reports it; absent = off
  defaults?: boolean // run on the shipped default limit instead of the pinned one
  files?: Record<string, string>
  clearWorks?: boolean
  compact?: (e: any) => any
  env?: Record<string, string>
}

const user = (text: string) => ({ role: 'user', text, toolUses: [] })
const asst = (text: string, toolUses: any[] = []) => ({ role: 'assistant', text, toolUses })
const use = (id: string, tool: string, input: any, text?: string) => ({ tool_use_id: id, tool, input, text })

// The approval scenarios below run on a pinned limit of 120k (60% of the 200k
// window) so their numbers stay readable; the shipped defaults (160k on 200k,
// 700k on 1M) have their own tests that pass defaults: true.
const PINNED = { thresholdPct: 60 }

// A fake world: files in a Map, a session whose id changes on /clear, and a
// person in front of the AskUserQuestion dialog who answers w.answer.
// Every question shown is recorded in w.asked, with its options, so a test
// proves what the person saw and that nothing happened without their yes.
function world(on: any, opts: Opts = {}) {
  const os = opts.os ?? 'windows'
  const cwd = os === 'windows' ? 'C:\\work' : '/work'
  const w = {
    cwd,
    sid: 'sid-one-1111',
    msgs: [] as any[],
    tokens: opts.tokens ?? 10_000,
    window: opts.window ?? 200_000,
    files: new Map<string, string>(Object.entries(opts.files ?? {})),
    store: new Map<string, unknown>(opts.defaults ? (opts.settings ? [['settings', opts.settings]] : []) : [['settings', { ...PINNED, ...opts.settings }]]),
    submitted: [] as any[],
    filled: [] as string[],
    commands: [] as string[],
    runs: [] as string[][],
    toasts: [] as string[],
    asked: [] as { question: string; options: string[] }[],
    answer: 'nobody' as Answer,
    nextPrompt: null as number | null,
  }
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('session.start', () => ({ cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: cwd }))
  on('session.id', () => ({ value: w.sid }))
  on('session.messages', () => ({ value: w.msgs }))
  on('session.usage', ($: any, e: any) => ({ value: { startedAt: 0, rateLimits: [], context: {
    tokens: w.tokens, window: w.window, percent: Math.round((w.tokens / w.window) * 100),
    ...(e?.breakdown ? { breakdown: { categories: [], totalTokens: w.tokens, maxTokens: w.window, rawMaxTokens: w.window, autocompactSource: 'auto', percentage: 0, gridRows: [], model: 'm', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: opts.compactAt !== undefined, ...(opts.compactAt ? { autoCompactThreshold: opts.compactAt } : {}), apiUsage: null } } : {}),
  } } }))
  mock.env(on, { ...(os === 'windows' ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } : { HOME: '/Users/me' }), ...(opts.env ?? {}) })
  on('store.get', ($: any, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', ($: any, e: any) => { w.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { w.store.delete(e.key); return { value: undefined } })
  on('fs.write', ($: any, e: any) => { w.files.set(norm(e.path), e.text); return { value: undefined } })
  on('fs.read', ($: any, e: any) => (w.files.has(norm(e.path)) ? { value: w.files.get(norm(e.path)) } : { deny: 'ENOENT' }))
  on('fs.exists', ($: any, e: any) => ({ value: w.files.has(norm(e.path)) }))
  on('process.run', ($: any, e: any) => { w.runs.push([...e.argv]); return { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'main\n' : '', stderr: '' } } })
  for (const name of ['command.register', 'tool.register', 'ui.log', 'ui.status', 'ui.copy']) on(name, () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.fill', ($: any, e: any) => { w.filled.push(e.text); return { isFilled: true } })
  on('command.run', ($: any, e: any) => {
    w.commands.push(e.command)
    if (e.command === 'clear' && opts.clearWorks !== false) { w.sid = 'sid-two-2222'; w.msgs = []; w.tokens = 0 }
    return { text: '' }
  })
  on('prompt.submit', ($: any, e: any) => { w.submitted.push(e); return { text: e.text, context: e.context } })
  on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($: any, e: any) {
    const prompt = w.nextPrompt ?? w.tokens
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 2, cache_read_input_tokens: prompt - 2, cache_creation_input_tokens: 0, output_tokens: 10, model: 'm' } }
  })
  on('classic.SessionStart', () => ({}))
  on('tool.call', ($: any, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ran', text: 'ran' }
    // $.ui.ask arrives here: the engine's own dialog
    const q = e.questions[0]
    const labels = (q.options ?? []).map((o: any) => (typeof o === 'string' ? o : o.label))
    w.asked.push({ question: q.question, options: labels })
    if (w.answer === 'nobody') return { deny: 'no one to ask (-p)' }
    if (w.answer === 'dismiss') return { deny: 'dismissed' }
    const label = labels.find((l: string) => l.startsWith(w.answer === 'yes' ? 'Yes' : 'No'))
    return { result: { answers: { [q.question]: label } } }
  })
  on('session.compact', ($: any, e: any) => (opts.compact ? opts.compact(e) : { messages: [user('core summary')] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const clock = mock.clock(on, { now: Date.parse('2026-11-01T10:00:00Z') })
  return { w, clock, os }
}

const BASE = { windows: 'C:/Users/me/.claude/session-transfer/C--work', mac: '/Users/me/.claude/session-transfer/-work' }

async function start($: any, w: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd } as any)
}

async function turn($: any, w: any, msgs: any[]) {
  w.msgs = [...w.msgs, ...msgs]
  await $.turn.start({ turnId: 't' + w.msgs.length } as any)
  await $.turn.complete({ turnId: 't' + w.msgs.length, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as any)
}

/** One model request whose API usage reports a prompt of `prompt` tokens. */
async function request($: any, w: any, prompt: number) {
  w.nextPrompt = prompt
  w.tokens = prompt
  const stream: any = $.turn.step({ turnId: 'r' + prompt, index: 0, model: 'm', messageCount: 1 } as any)
  for (;;) { const r = await stream.next(); if (r.done) break }
  w.nextPrompt = null
}

/** Lets timers (the suggestion, the handoff, its polling) run. */
async function settle(clock: any, ms = 3000) {
  for (let t = 0; t < ms; t += 250) await clock.advance(250)
}

/** A turn in which Claude reached the limit, was told so, and stopped with a status. */
async function stoppedTurn($: any, w: any) {
  await $.turn.start({ turnId: 'long' } as any)
  w.msgs = [...w.msgs, user('long task'), asst('step 1')]
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any) // the level changes to armed: the stop note
  w.msgs = [...w.msgs, asst('Status: done X, next Y')]
  await $.turn.complete({ turnId: 'long', answer: 'Status', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as any)
}

// The card reaches the fresh session as hidden prompt context, or (the engine's road) as a
// context block on the conversation's first message. Exactly one must carry it.
async function cardOf($: any, submitted: any) {
  const viaSubmit = (submitted?.context ?? []).join(' ')
  const ctx = await $.prompt.context({ blocks: [] } as any)
  const viaBlock = ctx.blocks.find((b: any) => b.name === 'sessionTransfer')?.text ?? ''
  if (viaSubmit && viaBlock) throw new Error('card delivered twice')
  return viaSubmit || viaBlock
}

function chunkFiles(w: any) {
  return [...w.files.keys()].filter((k: string) => /\/c\d{6}-r\d+-r\d+\.md$/.test(k))
}

function manifestOf(w: any) {
  return JSON.parse(w.files.get([...w.files.keys()].find((k: string) => k.endsWith('/thread.json'))!)!)
}

const composer = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as any

// ---------------------------------------------------------------- archive and lookups

for (const os of ['windows', 'mac'] as const) {
  test('every reply is archived to verified, immutable chunks (' + os + ')', async ($, on) => {
    const { w } = world(on, { os })
    await start($, w)
    await turn($, w, [user('add a login form'), asst('Added it', [use('a', 'Write', { file_path: w.cwd + '/src/login.tsx', content: 'x' }, 'ok')])])
    await turn($, w, [user('style it'), asst('Styled')])
    const chunks = chunkFiles(w)
    expect(chunks.length).toBe(2)
    expect(chunks.every((c) => c.includes(BASE[os].replace(/^C:/, '') + '/threads/'))).toBe(true) // the kit makes paths absolute on the host
    const manifest = manifestOf(w)
    expect(manifest.sessions[0].key).toBe('S1')
    expect(manifest.sessions[0].records).toBe(6)
    expect(manifest.sessions[0].coverage).toBe('complete')
    expect(manifest.firstAsk).toBe('add a login form')
    expect(w.files.get([...w.files.keys()].find((k) => k.endsWith('/session-transfer' + BASE[os].split('session-transfer')[1] + '/README.md'))!)).toMatch(/@@ r<n>/)
    await turn($, w, []) // a turn with nothing new writes nothing
    expect(chunkFiles(w).length).toBe(2)
  })
}

test('the lookup tools answer from the archive and count their cost', async ($, on) => {
  const { w } = world(on)
  await start($, w)
  await turn($, w, [user('why is the cache cold'), asst('The TTL is 5 minutes', [use('g', 'Grep', { pattern: 'ttl' }, 'src/cache.ts:3 ttl = 300')])])
  await turn($, w, [user('make it 1 hour'), asst('Set ttl to 3600')])
  const idx = await $.tool.call({ tool: 'mcp__session-transfer__history_index' } as any)
  expect(String(idx.result)).toMatch(/S1 T1 .*"why is the cache cold"/)
  expect(String(idx.result)).toMatch(/S1 T2 .*"make it 1 hour"/)
  const found = await $.tool.call({ tool: 'mcp__session-transfer__history_search', query: 'ttl', kind: 'result' } as any)
  expect(String(found.result)).toMatch(/result:Grep/)
  const read = await $.tool.call({ tool: 'mcp__session-transfer__history_read', ref: 'S1 T2' } as any)
  expect(String(read.result)).toMatch(/Set ttl to 3600/)
  // a guessed argument name (seen live: file_path) still reads the record
  const guessed = await $.tool.call({ tool: 'mcp__session-transfer__history_read', file_path: 'S1 T2' } as any)
  expect(String(guessed.result)).toMatch(/Set ttl to 3600/)
  const note = await $.tool.call({ tool: 'mcp__session-transfer__history_note', text: 'TTL must stay under 2h (CDN limit)' } as any)
  expect(String(note.result)).toMatch(/Noted/)
  expect(manifestOf(w).notes[0].text).toMatch(/CDN limit/)
})

// ---------------------------------------------------------------- supervised: nothing swaps without a yes

test('auto mode: at the limit the person is asked yes/no; a yes swaps and the card reaches the fresh session', async ($, on) => {
  const { w, clock } = world(on, { tokens: 130_000 }) // 65% of 200k; the pinned limit is 60% = 120k
  w.answer = 'yes'
  await start($, w)
  await turn($, w, [user('refactor the API layer'), asst('Done with step 1', [use('t', 'TodoWrite', { todos: [{ content: 'step 2: routes', status: 'pending' }] }, 'ok')])])
  expect(w.commands).not.toContain('clear') // nothing yet: the question comes first
  await settle(clock)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0].question).toMatch(/Context is at 130k tokens \(limit 120k\) in S1\. Continue in a fresh session\?/)
  expect(w.asked[0].options).toEqual(['Yes, swap', 'No, stay here'])
  expect(w.commands).toContain('clear')
  expect(w.sid).toBe('sid-two-2222')
  const card = await cardOf($, undefined)
  expect(card).toMatch(/<session-transfer-handoff thread="t\S+" from="S1" to="S2">/)
  expect(card).toMatch(/\[ \] step 2: routes/)
  expect(card).toMatch(/Last user request \(S1 T1, r1\): "refactor the API layer"/)
  const manifest = manifestOf(w)
  expect(manifest.sessions.map((s: any) => s.key)).toEqual(['S1', 'S2'])
  expect(manifest.sessions[1].parent).toBe('S1')
  expect(manifest.sessions[0].handoff.tokensBefore).toBe(130_000)
  expect(w.store.get('op')).toBeUndefined() // delivered: the transaction is closed
  expect(w.store.get('sess:sid-two-2222')).toEqual({ thread: manifest.id })
})

test('auto mode: a no keeps the session, and the question comes back only after real growth', async ($, on) => {
  const { w, clock } = world(on, { tokens: 130_000 })
  w.answer = 'no'
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(1)
  expect(w.commands).not.toContain('clear')
  expect(w.sid).toBe('sid-one-1111')
  expect(w.toasts.some((t) => /Staying in this session\. Asking again at 148k/.test(t))).toBe(true)
  // the person keeps typing: the message stays in this session, untouched
  const typed = await $.prompt.submit(composer('carry on here'))
  expect(typed.drop).toBeUndefined()
  expect(typed.text).toBe('carry on here')
  w.tokens = 140_000 // grew, but less than 15% of the limit: no new question
  await turn($, w, [user('more'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(1)
  w.tokens = 150_000 // past 148k: asked again
  await turn($, w, [user('more'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(2)
  expect(w.commands).not.toContain('clear')
})

test('auto mode: dismissing the question, or having no one to ask, never swaps', async ($, on) => {
  const { w, clock } = world(on, { tokens: 130_000 })
  w.answer = 'dismiss'
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(1)
  expect(w.commands).not.toContain('clear')
  w.answer = 'nobody' // a -p run: the dialog rejects
  w.tokens = 160_000
  await turn($, w, [user('more'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(2)
  expect(w.commands).not.toContain('clear')
  expect(w.sid).toBe('sid-one-1111')
})

test('auto mode: when Claude stopped for the limit, the yes option says it continues, and it does', async ($, on) => {
  const { w, clock } = world(on, { tokens: 110_000 }) // near: 92% of the 120k limit
  w.answer = 'yes'
  await start($, w)
  await turn($, w, [user('long task'), asst('step')])
  const near = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect((near.context ?? []).join(' ')).toMatch(/session-transfer, a Claude Code plugin the user installed: this session \(S1\) holds 110k tokens of context; its handoff limit is 120k\. No action is needed\./)
  const quiet = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(quiet.context ?? []).toEqual([]) // repeated sparingly
  w.tokens = 125_000
  await $.turn.start({ turnId: 'long' } as any)
  const stopNote = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect((stopNote.context ?? []).join(' ')).toMatch(/the user will be offered a fresh session/)
  expect((stopNote.context ?? []).join(' ')).not.toMatch(/automatically|end your turn/i)
  w.msgs = [...w.msgs, asst('Status: done X, next Y')]
  await $.turn.complete({ turnId: 'long', answer: 'Status', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as any)
  await settle(clock)
  expect(w.asked[0].options).toEqual(['Yes, swap and continue', 'No, stay here'])
  expect(w.commands).toContain('clear')
  const cont = w.submitted.find((s: any) => /Continue the task/.test(s.text))
  expect(cont).toBeDefined()
  expect(await cardOf($, cont)).toMatch(/continue the work where S1 stopped/)
})

test('manual mode: no question and no swap; the band says it is due and the person swaps from it', async ($, on) => {
  const { w, clock } = world(on, { tokens: 190_000, settings: { mode: 'manual' } })
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  expect(w.commands).not.toContain('clear')
  const r = await $.prompt.submit(composer('hello'))
  expect(r.drop).toBeUndefined()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await must(band, { type: 'Text', text: /swap when you are ready/ })
  await band.press({ key: 'st-band-handoff' }) // the person's own click is the approval
  await settle(clock)
  expect(w.commands).toContain('clear')
  await band.unmount()
})

test('a legacy "ask" setting reads as manual', async ($, on) => {
  const { w, clock } = world(on, { tokens: 190_000, settings: { mode: 'ask' } })
  w.answer = 'yes'
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  expect(w.commands).not.toContain('clear')
})

// ---------------------------------------------------------------- unattended: swaps without asking, per session

test('unattended (per session): no question; the next message moves to a fresh session, and the choice survives the swap', async ($, on) => {
  const { w, clock } = world(on, { tokens: 50_000 })
  w.answer = 'no' // would refuse if asked: proves it is never asked
  await start($, w)
  const set = await $.command.run({ command: 'transfer', args: 'unattended on' } as any)
  expect(set.text).toMatch(/Unattended is on for this session/)
  await turn($, w, [user('nightly migration'), asst('batch 1 done')])
  expect(manifestOf(w).unattended).toBe(true) // kept on the thread
  w.tokens = 130_000
  await turn($, w, [user('next batch'), asst('batch 2 done')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  const dropped = await $.prompt.submit(composer('run batch 3'))
  expect(dropped.drop).toMatch(/fresh session/)
  await settle(clock)
  expect(w.commands).toContain('clear')
  const resent = w.submitted.find((s: any) => s.text === 'run batch 3' && s.origin?.kind !== 'composer')
  expect(resent).toBeDefined()
  expect(await cardOf($, resent)).toMatch(/forwarded here unchanged/)
  expect(w.asked.length).toBe(0)
  // S2 is the same work: still unattended
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await must(band, { type: 'Text', text: /UNATTENDED/ })
  await band.unmount()
  const off = await $.command.run({ command: 'transfer', args: 'unattended off' } as any)
  expect(off.text).toMatch(/you are asked yes\/no/)
  expect(manifestOf(w).unattended).toBe(false)
})

test('unattended: when Claude stops for the limit, it swaps and continues with no one asked', async ($, on) => {
  const { w, clock } = world(on, { tokens: 125_000 })
  await start($, w)
  await $.command.run({ command: 'transfer', args: 'unattended on' } as any)
  await turn($, w, [user('start'), asst('ok')])
  await stoppedTurn($, w)
  await settle(clock)
  expect(w.asked.length).toBe(0)
  expect(w.commands).toContain('clear')
  expect(w.submitted.some((s: any) => /Continue the task/.test(s.text))).toBe(true)
})

test('SESSION_TRANSFER_UNATTENDED=1 forces unattended for the process; the per-session switch cannot turn it off', async ($, on) => {
  const { w, clock } = world(on, { tokens: 125_000, env: { SESSION_TRANSFER_UNATTENDED: '1' } })
  await start($, w)
  const off = await $.command.run({ command: 'transfer', args: 'unattended off' } as any)
  expect(off.text).toMatch(/forced on for this process/)
  await turn($, w, [user('start'), asst('ok')])
  await stoppedTurn($, w)
  await settle(clock)
  expect(w.asked.length).toBe(0)
  expect(w.commands).toContain('clear')
})

test('unattended never loops: a fresh session over the limit only by its own first prompt does not swap again', async ($, on) => {
  const { w, clock } = world(on, { env: { SESSION_TRANSFER_LIMIT: '30000' } })
  await start($, w)
  await $.command.run({ command: 'transfer', args: 'unattended on' } as any)
  await $.turn.start({ turnId: 'a' } as any)
  await request($, w, 52_000) // the first request: the floor
  w.msgs = [user('hi'), asst('hello')]
  await $.turn.complete({ turnId: 'a', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as any)
  await settle(clock)
  const r = await $.prompt.submit(composer('next'))
  expect(r.drop).toBeUndefined() // over 30k, but only by its base: no swap
  expect(w.commands).not.toContain('clear')
  await $.turn.start({ turnId: 'b' } as any)
  await request($, w, 60_000) // real growth past the floor
  w.msgs = [...w.msgs, user('read a big file'), asst('read')]
  await $.turn.complete({ turnId: 'b', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as any)
  await settle(clock)
  const moved = await $.prompt.submit(composer('go on'))
  expect(moved.drop).toMatch(/fresh session/)
  await settle(clock)
  expect(w.commands.filter((c) => c === 'clear').length).toBe(1)
  // S2 starts at 53k (base + card), still over 30k: it must not swap again
  await $.turn.start({ turnId: 'c' } as any)
  await request($, w, 53_000)
  w.msgs = [user('go on'), asst('continuing')]
  await $.turn.complete({ turnId: 'c', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer', usage: null } as any)
  await settle(clock)
  const again = await $.prompt.submit(composer('and more'))
  expect(again.drop).toBeUndefined()
  expect(w.commands.filter((c) => c === 'clear').length).toBe(1)
})

// ---------------------------------------------------------------- the shipped default limit

test('default limit on a 200k window is 160k: nothing at 150k, a question at 165k', async ($, on) => {
  const { w, clock } = world(on, { defaults: true, tokens: 150_000 })
  w.answer = 'no'
  await start($, w)
  await turn($, w, [user('task'), asst('step 1')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  w.tokens = 165_000
  await turn($, w, [user('next'), asst('step 2')])
  await settle(clock)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0].question).toMatch(/Context is at 165k tokens \(limit 160k\)/)
})

test('default limit on a 1M window is 700k: nothing at 650k, a question at 710k', async ($, on) => {
  const { w, clock } = world(on, { defaults: true, window: 1_000_000, tokens: 650_000 })
  w.answer = 'no'
  await start($, w)
  await turn($, w, [user('task'), asst('step 1')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  w.tokens = 710_000
  await turn($, w, [user('next'), asst('step 2')])
  await settle(clock)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0].question).toMatch(/Context is at 710k tokens \(limit 700k\)/)
})

test('a lower auto-compaction point wins: the question comes 5k before Claude Code would compact', async ($, on) => {
  // a 1M window whose compaction window was lowered (CLAUDE_CODE_AUTO_COMPACT_WINDOW, settings, the account)
  const { w, clock } = world(on, { defaults: true, window: 1_000_000, compactAt: 252_000, tokens: 240_000 })
  w.answer = 'no'
  await start($, w)
  await turn($, w, [user('task'), asst('step 1')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  w.tokens = 250_000
  await turn($, w, [user('next'), asst('step 2')])
  await settle(clock)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0].question).toMatch(/\(limit 247k\)/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await must(ui, { type: 'Text', text: /at 247k tokens \(just under Claude Code's auto-compact at 252k\)/ })
  await ui.unmount()
})

test('a compaction point past the limit changes nothing: 700k stays on a 1M window', async ($, on) => {
  const { w, clock } = world(on, { defaults: true, window: 1_000_000, compactAt: 967_000, tokens: 690_000 })
  w.answer = 'no'
  await start($, w)
  await turn($, w, [user('task'), asst('step 1')])
  await settle(clock)
  expect(w.asked.length).toBe(0)
  w.tokens = 705_000
  await turn($, w, [user('next'), asst('step 2')])
  await settle(clock)
  expect(w.asked[0]?.question).toMatch(/\(limit 700k\)/)
})

test('changing one setting stores only that change, so the window-based default still applies', async ($, on) => {
  const { w } = world(on, { defaults: true, window: 1_000_000, tokens: 10_000 })
  await start($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'st-tab-settings' })
  await ui.select({ key: 'st-set-mode', value: 'manual' })
  expect(w.store.get('settings')).toEqual({ mode: 'manual' })
  await ui.press({ key: 'st-tab-overview' })
  await must(ui, { type: 'Text', text: /at 700k tokens \(70% of window, default\)/ })
  await ui.unmount()
})

test('SESSION_TRANSFER_LIMIT sets the limit in tokens, over the settings', async ($, on) => {
  const { w, clock } = world(on, { tokens: 31_000, env: { SESSION_TRANSFER_LIMIT: '30000' } })
  w.answer = 'no'
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await settle(clock)
  expect(w.asked[0]?.question).toMatch(/\(limit 30k\)/)
})

test('a manual /clear starts new work supervised: no inherited arming, no inherited unattended', async ($, on) => {
  const { w } = world(on, { tokens: 130_000 })
  await start($, w)
  await $.command.run({ command: 'transfer', args: 'unattended on' } as any)
  await turn($, w, [user('task'), asst('ok')]) // armed, unattended
  w.sid = 'sid-manual-3333'
  w.msgs = []
  w.tokens = 5_000
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-manual-3333' } as any)
  const r = await $.prompt.submit(composer('new topic'))
  expect(r.drop).toBeUndefined()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await band.find({ type: 'Text', text: /UNATTENDED/ })).toBeUndefined()
  await band.unmount()
})

// ---------------------------------------------------------------- explicit handoffs, failure, recovery

test('/handoff (an explicit request) swaps at once; the card rides as a first-message context block, once', async ($, on) => {
  const { w, clock } = world(on, { tokens: 50_000 })
  await start($, w)
  await turn($, w, [user('write the parser'), asst('Parser written')])
  await $.command.run({ command: 'handoff', args: '' } as any)
  await settle(clock)
  expect(w.asked.length).toBe(0) // typing /handoff is the approval
  expect(w.sid).toBe('sid-two-2222')
  const ctx = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] } as any)
  const block = ctx.blocks.find((b: any) => b.name === 'sessionTransfer')
  expect(block.text).toMatch(/Last user request \(S1 T1, r1\): "write the parser"/)
  const next = await $.prompt.submit(composer('go on'))
  expect(next.context ?? []).toEqual([])
})

test('when the fresh session never starts, nothing is cleared and the message is put back', async ($, on) => {
  const { w, clock } = world(on, { tokens: 50_000, clearWorks: false }) // /clear does nothing: the id never changes
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await $.command.run({ command: 'handoff', args: 'keep this message' } as any)
  await settle(clock, 12_000)
  expect(w.sid).toBe('sid-one-1111')
  expect(w.filled).toContain('keep this message')
  expect((w.store.get('op') as any)?.phase).toBe('failed')
})

test('two handoff requests at once: one runs, the second is refused out loud', async ($, on) => {
  const { w, clock } = world(on, { tokens: 50_000 })
  await start($, w)
  await turn($, w, [user('task'), asst('ok')])
  await $.command.run({ command: 'handoff', args: 'first message' } as any)
  await $.command.run({ command: 'handoff', args: 'second message' } as any)
  await settle(clock)
  expect(w.commands.filter((c) => c === 'clear').length).toBe(1)
  expect(w.toasts.some((t) => /already under way/.test(t))).toBe(true)
  expect(w.submitted.some((s: any) => s.text === 'first message')).toBe(true)
})

test('chunks written before a failed manifest commit are recovered on reload', async ($, on) => {
  const base = BASE.windows + '/threads/t20261101-0900-abcdef'
  const manifest = JSON.stringify({ v: 1, id: 't20261101-0900-abcdef', cwd: 'C:/work', created: '2026-11-01T09:00:00.000Z', firstAsk: 'x', nextN: 2, chunkSeq: 1, notes: [], stats: {}, sessions: [{ key: 'S1', id: 'sid-one-1111', parent: null, reason: 'start', turn: 1, records: 1, chunks: ['c000001-r1-r1.md'], bytes: 10, coverage: 'complete', cursor: { fps: [], seen: [] } }] })
  const c1 = '@@ r1 user S1 T1 - len=1\nx\n\n'
  const orphan = '@@ r2 assistant S1 T1 - len=13\nthe lost part\n\n'
  const { w } = world(on, { files: { [base + '/thread.json']: manifest, [base + '/S1-sid-one-/c000001-r1-r1.md']: c1, [base + '/S1-sid-one-/c000002-r2-r2.md']: orphan } })
  on('fs.list', () => ({ value: [...w.files.keys()].filter((k) => k.includes('/S1-sid-one-/')).map((k) => ({ name: k.split('/').pop(), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  w.store.set('sess:sid-one-1111', { thread: 't20261101-0900-abcdef' })
  await start($, w)
  const found = await $.tool.call({ tool: 'mcp__session-transfer__history_search', query: 'lost part' } as any)
  expect(String(found.result)).toMatch(/r2 S1 T1 assistant/)
})

test('a reload in the middle of a handoff gives the held message back', async ($, on) => {
  const { w } = world(on)
  w.store.set('op', { id: 'x', from: 'sid-one-1111', phase: 'clearing', resubmit: 'my held message' })
  await start($, w)
  expect(w.filled).toContain('my held message')
  expect((w.store.get('op') as any).phase).toBe('failed')
})

// ---------------------------------------------------------------- compaction

test('auto-compaction is answered in place with the card, no summarizer; precompute is skipped', async ($, on) => {
  const { w } = world(on, { tokens: 195_000 })
  await start($, w)
  await turn($, w, [user('old work'), asst('old reply')])
  const pre = await $.session.compact({ trigger: 'precompute', messages: w.msgs } as any)
  expect(pre.skip).toMatch(/hands off/)
  const live = [...w.msgs, user('current job'), { ...asst('', [use('b', 'Bash', { command: 'make' }, 'built')]), handle: 'h9' }]
  const r = await $.session.compact({ trigger: 'auto', messages: live } as any)
  expect(r.skip).toBeUndefined()
  expect(r.messages[0].text).toMatch(/context filled up mid-task/)
  expect(r.messages[0].text).toMatch(/The request in progress \(verbatim\):\ncurrent job/)
  expect(r.messages[1].handle).toBe('h9')
  expect(r.tokensBefore).toBe(195_000)
  const manifest = manifestOf(w)
  expect(manifest.stats.handoffs[0].kind).toBe('emergency')
  expect(manifest.stats.precomputeSkipped).toBe(1)
  expect(manifest.sessions[0].records).toBe(5) // the turn in progress was archived before the context was replaced
})

test('a manual /compact still runs, told that the archive exists', async ($, on) => {
  let instructions = ''
  const { w } = world(on, { compact: (e: any) => { instructions = e.instructions ?? ''; return { messages: [user('core summary')] } } })
  await start($, w)
  await turn($, w, [user('a'), asst('b')])
  const r = await $.session.compact({ trigger: 'manual', messages: w.msgs, instructions: 'focus on tests' } as any)
  expect(r.messages[0].text).toBe('core summary')
  expect(instructions).toMatch(/^focus on tests[\s\S]*history_search/)
})

// ---------------------------------------------------------------- drawing

async function must(ui: any, q: any) {
  const found = await ui.find(q)
  if (!found) throw new Error('not drawn: ' + String(q.text) + ' :: ' + JSON.stringify(await ui.drawn()).slice(0, 3000))
  return found
}

const BAND = { plugin: 'session-transfer', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 130 } }
const PANE = { plugin: 'session-transfer', component: 'Pane', requestId: 'session-transfer', viewport: { columns: 140, rows: 40 }, props: { title: 'Session Transfer', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } }

for (const surface of ['terminal', 'desktop'] as const) {
  test('band states and every pane tab draw on ' + surface, async ($, on) => {
    const { w, clock } = world(on, { tokens: 130_000 })
    w.answer = 'no'
    await start($, w)
    await turn($, w, [user('ship the feature'), asst('Shipped')])
    const band = await $.ui.mount({ ...BAND, surface } as any)
    await must(band, { type: 'Text', text: /handoff due/ })
    await must(band, { type: 'Text', text: /a swap will be suggested/ })
    await must(band, { type: 'Button', key: 'st-band-handoff' })
    await settle(clock) // the person answers no
    await must(band, { type: 'Text', text: /you chose to stay · asking again at 148k/ })
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    await must(ui, { type: 'Text', text: /Session Transfer/ })
    await must(ui, { type: 'Text', text: /records · 1 turns/ })
    await must(ui, { type: 'Text', text: /you chose to stay/ })
    await ui.press({ key: 'st-tab-history' })
    await must(ui, { type: 'Text', text: /ship the feature/ })
    await ui.input({ key: 'st-search', text: 'shipped' })
    await must(ui, { type: 'Text', text: /1 match for "shipped"/ })
    await ui.press({ key: 'st-tab-savings' })
    await must(ui, { type: 'Text', text: /Context not re-read/ })
    await ui.press({ key: 'st-tab-settings' })
    await must(ui, { type: 'Text', text: /swap without asking: long unsupervised runs, servers/ })
    await ui.press({ key: 'st-unattended' })
    expect(manifestOf(w).unattended).toBe(true)
    await must(ui, { type: 'Button', key: 'st-unattended', text: /\[✓\] Unattended \(this session\)/ })
    await ui.press({ key: 'st-set-telemetry' })
    expect((w.store.get('settings') as any).telemetry).toBe(false)
    await ui.select({ key: 'st-set-mode', value: 'manual' })
    expect((w.store.get('settings') as any).mode).toBe('manual')
    await ui.unmount()
  })
}

test('a new session in the same project offers to continue the last thread', async ($, on) => {
  const latest = JSON.stringify({ thread: 't20261101-0900-abcdef', sid: 'old', at: '2026-11-01T09:00:00.000Z' })
  const manifest = JSON.stringify({ v: 1, id: 't20261101-0900-abcdef', cwd: 'C:/work', created: '2026-11-01T09:00:00.000Z', firstAsk: 'migrate the db', nextN: 3, chunkSeq: 1, notes: [], stats: {}, sessions: [{ key: 'S1', id: 'old-session-id', parent: null, reason: 'start', turn: 1, records: 2, chunks: ['c000001-r1-r2.md'], bytes: 10, coverage: 'complete', cursor: { fps: [], seen: [] } }] })
  const chunk = '@@ r1 user S1 T1 - len=14\nmigrate the db\n\n@@ r2 assistant S1 T1 - len=20\nMigration 1 applied.\n\n'
  const base = BASE.windows + '/threads/t20261101-0900-abcdef'
  const { w } = world(on, { files: { [BASE.windows + '/latest.json']: latest, [base + '/thread.json']: manifest, [base + '/S1-old-sess/c000001-r1-r2.md']: chunk } })
  await start($, w)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await must(band, { type: 'Text', text: /previous thread t20261101-0900-abcdef/ })
  await band.press({ key: 'st-band-attach' })
  const submitted = await $.prompt.submit(composer('continue'))
  const card = (submitted.context ?? []).join('\n')
  expect(card).toMatch(/from="S1" to="S2"/)
  expect(card).toMatch(/Migration 1 applied/)
  expect(card).toMatch(/Thread goal \(S1 T1\): migrate the db/)
  await band.unmount()
})
