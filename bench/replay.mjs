#!/usr/bin/env node
// Replays real Claude Code transcripts and compares, for the same work:
//   stock     what happened: the context grew, auto-compaction ran when it filled
//   transfer  session-transfer: hand off to a fresh context at the limit
//
//   node bench/replay.mjs [--limit 120000] [--card 1500] [--lookup 3000] [--min-requests 60]
//                         [--top 15] [--json] [transcript.jsonl | folder ...]
//
// With no paths it scans ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects).
//
// Method (stated so it can be argued with)
// - One request = one main-agent API call (isSidechain false), deduplicated by
//   requestId. Its prompt size P = input + cache_read + cache_creation tokens,
//   read from the usage the API returned.
// - Growth per request g = P_i - P_{i-1}. Across a compact_boundary the growth
//   is measured from the boundary's postTokens. A drop without a boundary is 0.
// - transfer replays the same growth from a fresh base: B0 (the median first
//   prompt of fresh sessions: system prompt + tools + CLAUDE.md) + card +
//   lookup allowance. When the simulated prompt crosses the limit, that request
//   is billed in full and the work keeps growing until the next prompt the
//   person types; the handoff happens there, as the mod does it. transfer never
//   auto-compacts, but a /compact the person typed (trigger manual) runs on
//   both sides and both pay for it.
// - A compaction boundary without token counts makes the next growth unknown:
//   it is left out (0), never guessed.
// - Both are priced with one cache model so they compare like for like: the
//   part of a prompt that was in the previous prompt reads from the cache
//   (x0.1), the new part is written to it (x1.25). After a handoff only B0 is
//   cached. Output tokens are the same in both and are left out.
// - stock also pays each compaction: its summarizer reads the whole context
//   (preTokens, priced as cache reads, which is generous to stock) and writes a
//   summary (8k output tokens, x5). Wall time comes from the boundary's
//   durationMs, as measured.
// What it does not measure: answer quality, or extra turns a fresh context
// may need. scripts/e2e-live.mjs checks recall; quality needs paired runs.

import { createReadStream, readdirSync, statSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const opt = (name, dflt) => (argv.includes('--' + name) ? Number(argv[argv.indexOf('--' + name) + 1]) : dflt)
const LIMIT = opt('limit', 120_000)
const CARD = opt('card', 1_500)
const LOOKUP = opt('lookup', 3_000)
// prompt: hand off at the next prompt the person types (conservative).
// stop:   the mod's context note asks Claude to stop at the limit and the work
//         continues in a fresh session: hand off one request after crossing.
const AT = argv.includes('--handoff') ? argv[argv.indexOf('--handoff') + 1] : 'prompt'
const MIN_REQ = opt('min-requests', 60)
const TOP = opt('top', 15)
const JSON_OUT = argv.includes('--json')
const W = { read: 0.1, write: 1.25, input: 1, output: 5 }
const SUMMARY_OUT = 8_000

const flagArgs = new Set(['--limit', '--card', '--lookup', '--min-requests', '--top', '--handoff'])
const paths = argv.filter((a, i) => !a.startsWith('--') && !flagArgs.has(argv[i - 1]))
const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

function listTranscripts(p) {
  if (!existsSync(p)) return []
  const st = statSync(p)
  if (st.isFile()) return p.endsWith('.jsonl') ? [p] : []
  const out = []
  for (const name of readdirSync(p)) {
    const full = join(p, name)
    const s = statSync(full)
    if (s.isDirectory() && p === root) out.push(...listTranscripts(full))
    else if (s.isFile() && name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

async function parse(file) {
  const reqs = []
  const seen = new Set()
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"usage"') && !line.includes('compact_boundary') && !line.includes('"type":"user"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const m = o.compactMetadata ?? {}
      // a missing count stays unknown (null), never zero
      reqs.push({ boundary: true, trigger: m.trigger, pre: m.preTokens ?? null, post: m.postTokens ?? null, ms: m.durationMs ?? 0 })
      continue
    }
    if (o.type === 'user') {
      // a turn boundary: a prompt the person typed (not a tool result, not engine meta)
      const c = o.message?.content
      const isPrompt = !o.isSidechain && !o.isMeta && !o.isCompactSummary && (typeof c === 'string' || (Array.isArray(c) && c.length && !c.some((b) => b.type === 'tool_result')))
      if (isPrompt) reqs.push({ turn: true })
      continue
    }
    if (o.type !== 'assistant' || o.isSidechain) continue
    const u = o.message?.usage
    if (!u || o.message?.model === '<synthetic>') continue // engine placeholders carry no real request
    const id = o.requestId ?? o.message?.id
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    const inp = u.input_tokens ?? 0
    const cr = u.cache_read_input_tokens ?? 0
    const cw = u.cache_creation_input_tokens ?? 0
    if (inp + cr + cw === 0) continue
    reqs.push({ P: inp + cr + cw, inp, cr, cw, out: u.output_tokens ?? 0 })
  }
  return reqs
}

function cost(prevCached, P) {
  const cached = Math.min(prevCached, P)
  return cached * W.read + (P - cached) * W.write
}

// The fresh-context base: system prompt + tools + instruction files. Taken from
// sessions that started fresh (first prompt under 80k); a resumed session's
// first prompt already carries old context and can't serve as a base.
let GLOBAL_B0 = 30_000

function simulate(reqs) {
  const calls = reqs.filter((r) => r.P !== undefined)
  if (!calls.length) return null
  const B0 = Math.min(calls[0].P, GLOBAL_B0)
  const base = B0 + CARD + LOOKUP
  const r = { requests: calls.length, compactions: 0, manualCompactions: 0, compactMs: 0, handoffs: 0, B0,
    stock: { prompt: 0, cost: 0, billed: 0, peak: 0 }, transfer: { prompt: 0, cost: 0, peak: 0 } }
  let prevP = null
  let afterBoundary = null
  let unknownGrowth = false
  let sim = null
  let simPrev = 0
  let stockPrev = 0
  let due = false // the transfer side crossed its limit; it hands off at the next prompt, as the mod does
  for (const q of reqs) {
    if (q.turn) {
      if (due && sim !== null) {
        r.handoffs++
        sim = base
        simPrev = B0
        due = false
      }
      continue
    }
    if (q.boundary) {
      r.compactions++
      r.compactMs += q.ms
      const pre = q.pre ?? prevP ?? 0
      r.stock.cost += pre * W.read + SUMMARY_OUT * W.output
      if (q.trigger === 'manual') {
        // the mod lets a /compact the person typed run: the transfer side pays it too
        r.manualCompactions++
        if (sim !== null) {
          r.transfer.cost += sim * W.read + SUMMARY_OUT * W.output
          sim = Math.min(sim, q.post ?? sim)
          simPrev = B0
        }
      }
      afterBoundary = q.post
      unknownGrowth = q.post === null
      stockPrev = B0 // a compaction rewrites the prefix: only the system part stays cached
      continue
    }
    // stock, as it happened
    r.stock.prompt += q.P
    r.stock.peak = Math.max(r.stock.peak, q.P)
    r.stock.cost += cost(stockPrev, q.P)
    r.stock.billed += q.inp * W.input + q.cr * W.read + q.cw * W.write
    stockPrev = q.P
    // growth of this request
    let g = 0
    if (prevP === null || unknownGrowth) g = 0 // unknown after a boundary without counts: excluded, not guessed
    else if (afterBoundary !== null) g = Math.max(0, q.P - afterBoundary)
    else g = Math.max(0, q.P - prevP)
    afterBoundary = null
    unknownGrowth = false
    prevP = q.P
    // transfer, replaying the same growth; the request that crosses the limit is billed in full
    if (sim === null) { sim = q.P; simPrev = 0 }
    else if (due && AT === 'stop') {
      r.handoffs++
      sim = base + g
      simPrev = B0
      due = false
    } else sim += g
    r.transfer.prompt += sim
    r.transfer.peak = Math.max(r.transfer.peak, sim)
    r.transfer.cost += cost(simPrev, sim)
    simPrev = sim
    if (sim >= LIMIT) due = true
  }
  return r
}

const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n)))
const pct = (a, b) => (b ? Math.round((1 - a / b) * 100) : 0)

const files = (paths.length ? paths : [root]).flatMap(listTranscripts)
const parsed = []
for (const f of files) {
  try { parsed.push([f, await parse(f)]) } catch {}
}
const firsts = parsed.map(([, q]) => q.find((r) => r.P !== undefined)?.P).filter((p) => p > 0 && p < 80_000).sort((a, b) => a - b)
if (firsts.length) GLOBAL_B0 = firsts[Math.floor(firsts.length / 2)]
const rows = []
for (const [f, reqs] of parsed) {
  const sim = simulate(reqs)
  if (!sim || sim.requests < MIN_REQ) continue
  rows.push({ file: basename(dirname(f)) + '/' + basename(f).slice(0, 8), ...sim })
}
rows.sort((a, b) => b.stock.cost - a.stock.cost)

const tot = rows.reduce((t, r) => {
  t.requests += r.requests; t.compactions += r.compactions; t.manual += r.manualCompactions; t.compactMs += r.compactMs; t.handoffs += r.handoffs
  t.sp += r.stock.prompt; t.sc += r.stock.cost; t.tp += r.transfer.prompt; t.tc += r.transfer.cost; t.billed += r.stock.billed
  return t
}, { requests: 0, manual: 0, compactions: 0, compactMs: 0, handoffs: 0, sp: 0, sc: 0, tp: 0, tc: 0, billed: 0 })

if (JSON_OUT) {
  console.log(JSON.stringify({ params: { AT, LIMIT, CARD, LOOKUP, MIN_REQ, weights: W, SUMMARY_OUT, B0: GLOBAL_B0 }, totals: tot, sessions: rows }, null, 1))
  process.exit(0)
}

console.log('fresh-context base (median first prompt of ' + firsts.length + ' fresh sessions): ' + fmt(GLOBAL_B0))
console.log('session-transfer replay · limit ' + fmt(LIMIT) + ' · card ' + fmt(CARD) + ' · lookup allowance ' + fmt(LOOKUP) + ' per handoff · ' + rows.length + ' sessions with >= ' + MIN_REQ + ' requests\n')
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
console.log(pad('session', 52) + lpad('reqs', 6) + lpad('compact', 8) + lpad('handoff', 8) + lpad('avg prompt', 18) + lpad('peak', 14) + lpad('input cost (equiv. tokens)', 32))
console.log(pad('', 52) + lpad('', 6) + lpad('stock', 8) + lpad('xfer', 8) + lpad('stock → xfer', 18) + lpad('stock → xfer', 14) + lpad('stock → xfer   saved', 32))
for (const r of rows.slice(0, TOP)) {
  console.log(
    pad(r.file.slice(0, 51), 52) + lpad(r.requests, 6) + lpad(r.compactions, 8) + lpad(r.handoffs, 8) +
    lpad(fmt(r.stock.prompt / r.requests) + ' → ' + fmt(r.transfer.prompt / r.requests), 18) +
    lpad(fmt(r.stock.peak) + ' → ' + fmt(r.transfer.peak), 14) +
    lpad(fmt(r.stock.cost) + ' → ' + fmt(r.transfer.cost) + '   ' + pct(r.transfer.cost, r.stock.cost) + '%', 32),
  )
}
if (rows.length > TOP) console.log('… ' + (rows.length - TOP) + ' more (use --top N)')
console.log('\nAll ' + rows.length + ' sessions: ' + tot.requests + ' requests, ' + tot.compactions + ' compactions (' + tot.manual + ' typed by the person, charged to both sides; ' + Math.round(tot.compactMs / 1000) + ' s of compaction wait, measured), ' + tot.handoffs + ' handoffs simulated')
console.log('Prompt tokens re-sent:   stock ' + fmt(tot.sp) + ' → transfer ' + fmt(tot.tp) + '  (' + pct(tot.tp, tot.sp) + '% fewer)')
console.log('Input cost, cache model: stock ' + fmt(tot.sc) + ' → transfer ' + fmt(tot.tc) + ' input-token equivalents  (' + pct(tot.tc, tot.sc) + '% less)')
console.log('Stock as billed (usage fields, for reference): ' + fmt(tot.billed) + ' input-token equivalents')
console.log('\nWeights: cache read x' + W.read + ', cache write x' + W.write + ', output x' + W.output + ' of the input price. Quality and extra turns are not measured here.')
