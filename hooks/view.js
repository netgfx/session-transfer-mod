// session-transfer: drawing. Pure functions over a view model; the hooks
// module passes the element constructors and the action callbacks in.
// Single-width glyphs only (● ▲ ↯ ✓ ✕ █ ░ │ ▁..█), so it lines up in Windows
// Terminal, conhost, iTerm2 and Terminal.app alike.

import { gauge, short, sparkline, bytes, savings, clockTime, ago, MODES, THRESHOLDS, CAPS } from './lib.js'

const LEVEL = {
  ok: { icon: '●', color: 'green', word: 'healthy' },
  filling: { icon: '●', color: 'yellow', word: 'filling' },
  near: { icon: '▲', color: 'magenta', word: 'handoff soon' },
  armed: { icon: '↯', color: 'red', word: 'handoff due' },
}

const PHASE_TEXT = {
  archiving: 'archiving and verifying',
  copying: 'copying the raw transcript',
  clearing: 'opening a fresh session',
  sending: 'sending your message to the fresh session',
}

// ---------------------------------------------------------------- band

/** One row above the prompt. Returns null when there's nothing worth a row. */
export function band(el, m, act) {
  const { Box, Text, Button } = el
  const cols = m.columns ?? 100
  const lv = LEVEL[m.level] ?? LEVEL.ok
  const parts = []
  const btn = (key, label, onPress, hotkey) => Button({ key, label, plain: true, onPress, ...(hotkey ? { hotkey } : {}) })

  if (m.phase) {
    parts.push(Text({ color: 'cyan', bold: true, children: ['… handing off: ' + (PHASE_TEXT[m.phase] ?? m.phase)] }))
    return row(Box, parts)
  }
  if (m.failure) {
    parts.push(Text({ color: 'red', bold: true, children: ['✕ handoff failed: ' + m.failure] }))
    parts.push(Text({ children: ['  '] }))
    parts.push(btn('st-band-dismiss', 'dismiss', act.dismiss))
    return row(Box, parts)
  }
  if (m.pendingCard) {
    parts.push(Text({ color: 'cyan', bold: true, children: ['✓ fresh session ' + m.sessionKey] }))
    parts.push(Text({ children: [' · continuing ' + m.pendingCard.from + ' · the ' + short(m.pendingCard.tokens) + '-token handoff card rides on your next message'] }))
    if (cols >= 110) parts.push(Text({ dimColor: true, children: [' · ' + m.totalRecords + ' records searchable'] }))
    return row(Box, parts)
  }
  if (m.offerThread) {
    parts.push(Text({ color: 'cyan', bold: true, children: ['◆ transfer'] }))
    parts.push(Text({ children: [' · previous thread ' + m.offerThread.id + ' (' + m.offerThread.sessions + ' sessions, ' + ago(m.offerThread.ageMs) + ')  '] }))
    parts.push(btn('st-band-attach', '[continue it]', act.attachThread))
    parts.push(Text({ children: [' '] }))
    parts.push(btn('st-band-ignore', '[start fresh]', act.ignoreThread))
    return row(Box, parts)
  }
  if (!m.window) return null

  const off = m.settings.mode === 'off'
  const baseOnly = m.level === 'armed' && m.grown === false // over the limit by its own starting size: nothing to gain
  const armed = m.level === 'armed' && !off && !baseOnly
  const title = off ? '○ transfer off' : m.asking ? '? swap suggested' : lv.icon + ' ' + (armed ? 'handoff due' : 'transfer')
  parts.push(Text({ color: off ? undefined : m.asking ? 'cyan' : lv.color, bold: true, dimColor: off, children: [title] }))
  if (m.unattended && !off) parts.push(Text({ color: 'yellow', bold: true, children: [' UNATTENDED'] }))
  const gw = cols >= 120 ? 22 : cols >= 90 ? 14 : 0
  if (gw) parts.push(Text({ color: lv.color, children: [' ' + gauge(m.tokens, m.window, m.limit, gw)] }))
  parts.push(Text({ children: [' ' + short(m.tokens) + '/' + short(m.limit)] }))
  const say = (text, color) => parts.push(Text({ color, dimColor: !color, children: [' · ' + text] }))
  if (armed && m.asking) say('answer the question: yes swaps, no stays', 'cyan')
  else if (baseOnly && !off) say(cols >= 110 ? 'over the limit by its own starting size only: a swap would not help' : 'base size: no swap')
  else if (armed && m.unattended) say('unattended: the next message starts a fresh session', 'red')
  else if (armed && m.snoozeUntil > m.tokens) say(cols >= 110 ? 'you chose to stay · asking again at ' + short(m.snoozeUntil) : 'stay · ask at ' + short(m.snoozeUntil))
  else if (armed && m.settings.mode === 'manual') say('swap when you are ready', 'red')
  else if (armed) say(cols >= 110 ? 'a swap will be suggested' : 'swap soon', 'red')
  else if (cols >= 100) {
    say(m.sessionKey + ' · ' + m.totalRecords + ' rec')
    if (m.handoffs) say(m.handoffs + ' handoff' + (m.handoffs === 1 ? '' : 's'))
  }
  parts.push(Text({ children: ['  '] }))
  if (!off && !m.asking) parts.push(btn('st-band-handoff', armed ? '[swap now]' : '[hand off]', act.handoff))
  parts.push(Text({ children: [' '] }))
  parts.push(btn('st-band-open', '[panel]', act.openPane))
  return row(Box, parts)
}

function row(Box, children) {
  return Box({ flexDirection: 'row', paddingX: 1, children })
}

// ---------------------------------------------------------------- pane

const TABS = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'history', label: 'History', key: '2' },
  { id: 'savings', label: 'Savings', key: '3' },
  { id: 'settings', label: 'Settings', key: '4' },
]

export function pane(el, m, act) {
  const { Box, Text, Button } = el
  const cols = Math.max(40, m.columns ?? 80)
  const tabs = Box({
    flexDirection: 'row',
    columnGap: 1,
    children: TABS.map((t) =>
      Button({ key: 'st-tab-' + t.id, label: (m.tab === t.id ? '▸ ' : '') + t.label, plain: true, hotkey: t.key, onPress: () => act.setTab(t.id) }),
    ),
  })
  const body =
    m.tab === 'history' ? history(el, m, act, cols) : m.tab === 'savings' ? savingsTab(el, m, cols) : m.tab === 'settings' ? settingsTab(el, m, act) : overview(el, m, act, cols)
  return Box({
    flexDirection: 'column',
    paddingX: 1,
    children: [
      Box({ flexDirection: 'row', children: [Text({ bold: true, color: 'cyan', children: ['◆ Session Transfer'] }), Text({ dimColor: true, children: ['  ' + (m.threadId ?? 'no thread yet') + ' · ' + m.sessionKey] })] }),
      tabs,
      Text({ dimColor: true, children: ['─'.repeat(Math.min(cols - 2, 72))] }),
      body,
    ],
  })
}

function kv(Text, Box, k, v, color) {
  return Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: [(k + '        ').slice(0, 9)] }), typeof v === 'string' ? Text({ color, children: [v] }) : v] })
}

function overview(el, m, act, cols) {
  const { Box, Text, Button } = el
  const lv = LEVEL[m.level] ?? LEVEL.ok
  const gw = Math.max(12, Math.min(48, cols - 34))
  const rows = []
  if (m.window) {
    rows.push(kv(Text, Box, 'Context', Box({ flexDirection: 'row', children: [Text({ color: lv.color, children: [gauge(m.tokens, m.window, m.limit, gw)] }), Text({ children: ['  ' + (m.percent ?? 0) + '% · ' + short(m.tokens) + ' of ' + short(m.window)] })] })))
    const why = m.limitFromEnv ? 'set by SESSION_TRANSFER_LIMIT' : m.settings.thresholdPct + '% of window' + (m.settings.capTokens ? ', cap ' + short(m.settings.capTokens) : '')
    rows.push(kv(Text, Box, 'Handoff', Text({ children: ['at ' + short(m.limit) + ' tokens (' + why + ') · mode ' + m.settings.mode + (m.unattended ? ' · UNATTENDED' : '')] })))
  } else {
    rows.push(kv(Text, Box, 'Context', 'no reading yet: it appears after the first reply'))
  }
  const status = m.phase
    ? '… ' + (PHASE_TEXT[m.phase] ?? m.phase)
    : m.failure
      ? '✕ last handoff failed: ' + m.failure
      : m.pendingCard
        ? '✓ fresh session; the handoff card from ' + m.pendingCard.from + ' rides on your next message'
        : m.asking
          ? '? a swap to a fresh session is suggested: answer yes or no'
          : lv.icon + ' ' + lv.word + (m.level !== 'armed' || m.settings.mode === 'off' ? '' : m.grown === false ? ': over the limit by its own starting size only; a swap would not help' : m.unattended ? ': unattended, the next message starts a fresh session' : m.snoozeUntil > m.tokens ? ': you chose to stay; asking again at ' + short(m.snoozeUntil) : m.settings.mode === 'manual' ? ': swap when you are ready' : ': a swap will be suggested at the end of the turn')
  rows.push(kv(Text, Box, 'Status', status, m.failure ? 'red' : m.phase || m.pendingCard ? 'cyan' : lv.color))
  rows.push(
    kv(
      Text,
      Box,
      'Archive',
      m.totalRecords + ' records · ' + m.totalTurns + ' turns · ' + m.sessionsCount + ' session' + (m.sessionsCount === 1 ? '' : 's') + ' · ' + bytes(m.archiveBytes) + (m.lastWrite ? ' · saved ' + clockTime(m.lastWrite.time) + (m.lastWrite.ok ? ' ✓ verified' : ' ✕ ' + m.lastWrite.error) : ''),
      m.lastWrite && !m.lastWrite.ok ? 'red' : undefined,
    ),
  )
  if (m.coverage && m.coverage !== 'complete') rows.push(kv(Text, Box, 'Coverage', m.coverage, 'yellow'))
  rows.push(kv(Text, Box, 'Raw', m.rawText ?? 'copied at each handoff', m.rawOk === false ? 'yellow' : undefined))
  rows.push(kv(Text, Box, 'Folder', Text({ dimColor: true, wrap: 'truncate-start', children: [m.archiveDir ?? '-'] })))
  rows.push(Text({ children: [' '] }))
  rows.push(
    Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({ key: 'st-handoff', label: 'h  Hand off now', hotkey: 'h', onPress: act.handoff }),
        Button({ key: 'st-handoff-continue', label: 'c  Hand off & continue', hotkey: 'c', onPress: act.handoffContinue }),
      ],
    }),
  )
  rows.push(
    Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({ key: 'st-archive', label: 'a  Archive now', hotkey: 'a', onPress: act.archiveNow }),
        Button({ key: 'st-copy', label: 'y  Copy folder path', hotkey: 'y', onPress: act.copyPath }),
      ],
    }),
  )
  rows.push(Text({ children: [' '] }))
  const st = m.stats
  if (st && st.samples.length > 1) {
    rows.push(Text({ dimColor: true, children: ['Prompt size per request · ' + st.samples.length + ' requests · │ marks a handoff'] }))
    rows.push(Text({ color: 'cyan', children: [sparkline(st.samples, Math.min(cols - 4, 72), st.marks)] }))
    rows.push(Text({ dimColor: true, children: ['peak ' + short(Math.max(...st.samples)) + ' · now ' + short(st.samples[st.samples.length - 1])] }))
  } else {
    rows.push(Text({ dimColor: true, children: ['A graph of prompt size per request appears here as you work.'] }))
  }
  rows.push(Text({ dimColor: true, children: ['Hand off moves the work to a fresh session. Every prompt, reply and tool result stays searchable there.'] }))
  return Box({ flexDirection: 'column', children: rows })
}

function history(el, m, act, cols) {
  const { Box, Text, Input, Button } = el
  const rows = []
  rows.push(Text({ bold: true, children: ['Sessions in this thread'] }))
  for (const s of m.sessions ?? []) {
    const cur = s.key === m.sessionKey
    const h = s.handoff
    rows.push(
      Text({
        color: cur ? 'cyan' : undefined,
        children: [
          (cur ? '▸ ' : '  ') + s.key + ' ' + String(s.id).slice(0, 8) + '  ' + (s.parent ? '← ' + s.parent + ' (' + s.reason + ')' : 'start') + '  ' + s.turn + ' turns · ' + s.records + ' records' + (h ? ' · handed off at ' + short(h.tokensBefore) : '') + (s.coverage !== 'complete' ? ' · ' + s.coverage : ''),
        ],
      }),
    )
  }
  rows.push(Text({ children: [' '] }))
  rows.push(
    Input({
      key: 'st-search',
      label: 'Search',
      placeholder: 'words, a file name, an error…',
      value: '',
      submitLabel: 'search',
      onSubmit: act.search,
    }),
  )
  const res = m.searchResult
  if (res) {
    if (res.error) rows.push(Text({ color: 'red', children: [res.error] }))
    else {
      rows.push(Text({ dimColor: true, children: [res.total + ' match' + (res.total === 1 ? '' : 'es') + ' for "' + res.query + '"' + (res.total > res.hits.length ? ' · newest ' + res.hits.length + ' shown' : '')] }))
      for (const h of res.hits) {
        rows.push(Box({ flexDirection: 'row', children: [Text({ color: 'cyan', children: [('r' + h.n + ' ' + h.s + ' T' + h.t + ' ' + h.kind + '                ').slice(0, 26)] }), Text({ wrap: 'truncate-end', children: [h.snippet] })] }))
      }
    }
    rows.push(Button({ key: 'st-search-clear', label: 'clear results', plain: true, onPress: act.clearSearch }))
  }
  rows.push(Text({ children: [' '] }))
  rows.push(Text({ bold: true, children: ['Recent turns'] }))
  const turns = (m.turns ?? []).slice(-Math.max(4, Math.min(12, Math.floor((cols - 10) / 6))))
  if (!turns.length) rows.push(Text({ dimColor: true, children: ['Nothing archived yet. The archive updates after every reply.'] }))
  for (const t of turns) {
    rows.push(
      Box({
        flexDirection: 'row',
        children: [
          Text({ dimColor: true, children: [(t.s + ' T' + t.t + '        ').slice(0, 9)] }),
          Text({ wrap: 'truncate-end', children: [t.ask || '(continued)'] }),
          Text({ dimColor: true, children: [t.files.length ? '  ✎ ' + t.files.length : ''] }),
          Text({ color: 'red', children: [t.errors ? '  ✕ ' + t.errors : ''] }),
        ],
      }),
    )
  }
  rows.push(Text({ dimColor: true, children: ['Claude reads the same history with the history_index / history_search / history_read tools.'] }))
  return Box({ flexDirection: 'column', children: rows })
}

function savingsTab(el, m, cols) {
  const { Box, Text } = el
  const s = savings(m.stats)
  const rows = []
  // narrow (a docked pane): shorter labels, notes only where they fit on the line
  const lw = cols >= 90 ? 30 : 26
  const line = (label, value, note, color) =>
    Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: [(label + ' '.repeat(lw)).slice(0, lw)] }), Text({ bold: true, color, wrap: 'truncate-end', children: [value] }), Text({ dimColor: true, wrap: 'truncate-end', children: [note && cols >= 90 ? '  ' + note : ''] })] })
  rows.push(Text({ bold: true, children: ['Measured'] }))
  rows.push(line('Model requests', String(s.requests), 'main agent, this thread'))
  rows.push(line('Average prompt', short(s.avgPrompt) + ' tokens', 'peak ' + short(s.peakPrompt)))
  rows.push(line('Cache hit rate', s.cacheHitPct + '%', 'share of prompt tokens read from the cache'))
  rows.push(line('Handoffs', String(s.handoffs), s.emergencies ? s.emergencies + ' emergency reduction' + (s.emergencies === 1 ? '' : 's') : ''))
  rows.push(line('Handoff card size', s.avgCardTokens ? '≈' + short(s.avgCardTokens) + ' tokens' : '-', 'what a fresh session starts with'))
  rows.push(line('History lookups', s.lookupCalls + ' calls', '≈' + short(s.lookupTokens) + ' tokens read back'))
  rows.push(line('Precompute skipped', String(s.precomputeSkipped), 'background summaries not paid for'))
  rows.push(Text({ children: [' '] }))
  rows.push(Text({ bold: true, children: ['Estimated (vs. staying on the old context)'] }))
  rows.push(line('Context not re-read', short(s.rereadAvoided) + ' tokens', '≈' + short(s.rereadAvoidedCacheEq) + ' at cache-read price', 'green'))
  rows.push(line('Summarizer input avoided', short(s.summarizerAvoided) + ' tokens', 'emergency reductions only'))
  rows.push(Text({ children: [' '] }))
  rows.push(Text({ dimColor: true, wrap: 'wrap', children: ['Measured rows come from the API usage of each request. Estimates assume the work would have continued on the old context, which makes them an upper bound. To compare against stock auto-compaction on your own transcripts, run bench/replay.mjs (see README).'] }))
  if (cols < 60) rows.push(Text({ dimColor: true, children: ['Widen the pane for more detail.'] }))
  return Box({ flexDirection: 'column', children: rows })
}

function settingsTab(el, m, act) {
  const { Box, Text, Select, Button } = el
  const s = m.settings
  const toggle = (key, label, value, help) =>
    Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [Button({ key: 'st-set-' + key, label: (value ? '[✓] ' : '[ ] ') + label, plain: true, onPress: () => act.setSetting(key, !value) }), Text({ dimColor: true, children: [help] })],
    })
  return Box({
    flexDirection: 'column',
    children: [
      Select({
        key: 'st-set-mode',
        label: 'Mode',
        value: s.mode,
        options: MODES.map((v) => ({ value: v, label: v === 'auto' ? 'auto: at the limit, ask me yes/no to swap' : v === 'manual' ? 'manual: show the limit, I swap myself' : 'off: archive only, never swap' })),
        onSelect: (v) => act.setSetting('mode', v),
      }),
      Select({
        key: 'st-set-threshold',
        label: 'Hand off at',
        value: String(s.thresholdPct),
        options: THRESHOLDS.map((v) => ({ value: String(v), label: v + '% of the context window' })),
        onSelect: (v) => act.setSetting('thresholdPct', Number(v)),
      }),
      Select({
        key: 'st-set-cap',
        label: 'Token cap',
        value: String(s.capTokens),
        options: CAPS.map((v) => ({ value: String(v), label: v ? 'at most ' + short(v) + ' tokens' : 'no cap' })),
        onSelect: (v) => act.setSetting('capTokens', Number(v)),
      }),
      Text({ children: [' '] }),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Button({ key: 'st-unattended', label: (m.unattended ? '[✓] ' : '[ ] ') + 'Unattended (this session)', plain: true, onPress: act.toggleUnattended }),
          Text({ color: m.unattended ? 'yellow' : undefined, dimColor: !m.unattended, children: [m.unattendedForced ? 'forced on by SESSION_TRANSFER_UNATTENDED=1' : 'swap without asking: long unsupervised runs, servers'] }),
        ],
      }),
      toggle('replaceCompaction', 'Replace auto-compaction', s.replaceCompaction, 'hand off in place instead of paying for a summary'),
      toggle('telemetry', 'Tell Claude its context size', s.telemetry, 'near the limit, so it stops at a clean point'),
      toggle('autoContinue', 'Continue automatically', s.autoContinue, 'after a swap that Claude stopped for (yes, or unattended)'),
      toggle('showBand', 'Show the band above the prompt', s.showBand, ''),
      Text({ children: [' '] }),
      Text({ dimColor: true, children: ['Limit now: ' + short(m.limit) + ' tokens. Settings apply to every session on this machine.'] }),
    ],
  })
}
