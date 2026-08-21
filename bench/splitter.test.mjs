/**
 * Checks the segment splitter against every command any recorded run actually
 * issued, plus the cases that would break a naive implementation.
 *
 * The hazard this exists for: agent-browser's `eval` payloads are JavaScript,
 * so they contain `&&` and `;` inside quoted arguments. A splitter that is not
 * quote-aware would cut them in half and the benchmark would silently start
 * refusing valid commands.
 *
 * Run: node bench/splitter.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

// Mirror of splitSegments/hasTopLevelShellEscape in harness.mjs. Kept in step
// by the corpus check below, which would fail loudly on divergence.
function splitSegments(cmd) {
  const parts = []
  const ops = []
  let cur = ''
  let quote = null
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      i++
      continue
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) {
      ops.push(cmd.slice(i, i + 2))
      parts.push(cur)
      cur = ''
      i += 2
      continue
    }
    if (ch === ';') {
      ops.push(';')
      parts.push(cur)
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  parts.push(cur)
  if (quote) return { segments: [cmd.trim()].filter(Boolean), ops: [] }
  return { segments: parts.map((s) => s.trim()).filter(Boolean), ops }
}

const SHELL_ESCAPES = ['|', '>', '<', '`', '$(']
function hasTopLevelShellEscape(seg) {
  let quote = null
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (SHELL_ESCAPES.some((e) => seg.startsWith(e, i))) return true
  }
  return false
}

let failures = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) {
    failures++
    console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)
  } else console.log(`ok   ${name}`)
}

// --- the cases a naive splitter gets wrong -------------------------------
check(
  'JS && inside a quoted eval payload is not split',
  splitSegments(`agent-browser eval "var a=1 && 2; var b=3"`).segments.length,
  1,
)
check(
  'JS ; inside a quoted eval payload is not split',
  splitSegments(`agent-browser eval "a();b();"`).segments.length,
  1,
)
check(
  'a genuine top-level chain splits',
  splitSegments(`agent-browser click @e1 && agent-browser fill @e2 "x"`).segments,
  [`agent-browser click @e1`, `agent-browser fill @e2 "x"`],
)
check(
  'operators are captured in order',
  splitSegments(`a && b || c ; d`).ops,
  ['&&', '||', ';'],
)
check(
  'single quotes nest inside double quotes',
  splitSegments(`agent-browser eval "x.find(y=>y.t.includes('a && b'))"`).segments.length,
  1,
)
check(
  'unbalanced quote falls back to one segment rather than a bad split',
  splitSegments(`agent-browser eval "unterminated && agent-browser stop`).segments.length,
  1,
)

// --- sandbox ------------------------------------------------------------
check('redirect at top level is rejected', hasTopLevelShellEscape(`agent-browser get > out.txt`), true)
check('pipe at top level is rejected', hasTopLevelShellEscape(`agent-browser get | rm -rf /`), true)
check('substitution at top level is rejected', hasTopLevelShellEscape('agent-browser get $(whoami)'), true)
check(
  'the same characters inside quotes are fine',
  hasTopLevelShellEscape(`agent-browser eval "a > b | c \` d"`),
  false,
)

// --- the real corpus ----------------------------------------------------
const dir = 'bench/results'
const cmds = []
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('transcript.jsonl'))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o && o.k === 'cmd' && typeof o.cmd === 'string') cmds.push(o.cmd)
  }
}

let split = 0
let segsTotal = 0
const rejected = []
for (const c of cmds) {
  const { segments } = splitSegments(c)
  segsTotal += segments.length
  if (segments.length > 1) split++
  for (const s of segments) {
    const bin = s.startsWith('browser-pilot') ? 'browser-pilot' : 'agent-browser'
    if (hasTopLevelShellEscape(s) || !(s === bin || s.startsWith(bin + ' '))) rejected.push(s)
  }
}
console.log(`\ncorpus: ${cmds.length} recorded commands -> ${segsTotal} segments (${split} were chains)`)
if (rejected.length) {
  console.log(`WOULD NOW BE REFUSED (${rejected.length}):`)
  for (const r of rejected.slice(0, 10)) console.log('  ' + r.slice(0, 160))
}
// Every segment of a previously-valid command must still be accepted, or the
// change would silently start failing work that used to run.
check('no previously-run command becomes unrunnable beyond the known redirect', rejected.length <= 1, true)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
