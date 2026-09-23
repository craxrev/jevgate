// Quote-aware shell splitter for the local free-set check. It never runs
// anything and is deliberately conservative: anything it does not understand
// is reported in `syntax`, and a command with any syntax finding is not free.
// Jev always receives the command as written; segments are for this file's
// callers only.

export type Segment = {
  /** The segment as written, trimmed. Heredoc bodies are in `scripts`. */
  text: string;
  /** Basename of the first word after env prefixes and `command`/`builtin`/`noglob`. */
  program: string;
  /** Words after the program, quotes removed. */
  args: string[];
  /** Args starting with `-`, `--name=value` reduced to `--name`. */
  flags: string[];
  /** Names of leading `VAR=value` assignments. */
  env: string[];
  /** Wrapper noted: `sh -c`, `env`, `time`, `timeout`, `nohup`, `sudo`, `xargs`. */
  label?: string;
  /** Some word has an unquoted `*`, `?` or `[`. */
  globs: boolean;
  /** Some word contains `$` (quoted or not). */
  dollar: boolean;
  /** Some word contains a newline. */
  newline: boolean;
};

export type Script = { lang: string; body: string };

export type Parsed = {
  segments: Segment[];
  scripts: Script[];
  /** Findings that disqualify a command from the free set. Deduplicated, in first-seen order. */
  syntax: string[];
};

type Word = { value: string; quoted: boolean; glob: boolean; dollar: boolean };

/** A `$` followed by one of these can expand; any other `$` (a regex anchor before `"`, a trailing `$`) is literal. */
const EXPANDS = /[A-Za-z_{(0-9@*#?!$-]/;
const EXPANSION = /\$[A-Za-z_{(0-9@*#?!$-]/;

type Redirect = { op: string; fd?: string; target?: Word };

const OK_FD_TARGET = /^\d+$/;
const WRAPPERS = new Set(['env', 'time', 'timeout', 'nohup', 'sudo', 'xargs']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'select', 'in', 'coproc', '{', '}',
]);
const STRIP_PREFIX = new Set(['command', 'builtin', 'noglob']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VAR_START = /[A-Za-z_0-9@*#?$!\-]/;

/** Language label for an inline body, from the program that consumes it. */
function langOf(program: string): string {
  if (/^python\d*(\.\d+)?$/.test(program)) return 'python';
  if (SHELLS.has(program)) return 'sh';
  if (program === 'cat' || program === 'tee' || program === '') return 'text';
  return program;
}

export function parseShell(source: string): Parsed {
  const syntax: string[] = [];
  const flag = (f: string) => {
    if (!syntax.includes(f)) syntax.push(f);
  };
  const segments: Segment[] = [];
  const scripts: Script[] = [];

  const n = source.length;
  let i = 0;
  // Current segment under construction.
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let segStart = 0;
  let pendingHeredocs: { delim: string; strip: boolean }[] = [];
  let heredocBodies: string[] = [];

  const finishSegment = (end: number) => {
    const text = source.slice(segStart, end).trim();
    if (words.length === 0 && redirects.length === 0 && heredocBodies.length === 0) {
      segStart = end;
      return;
    }
    const seg = buildSegment(text, words, flag);
    for (const r of redirects) checkRedirect(r, flag);
    if (seg) {
      segments.push(seg);
      for (const body of heredocBodies) scripts.push({ lang: langOf(seg.program), body });
      extractInline(seg, scripts);
    } else {
      for (const body of heredocBodies) scripts.push({ lang: 'text', body });
    }
    words = [];
    redirects = [];
    heredocBodies = [];
    segStart = end;
  };

  /** Consume heredoc bodies starting at `pos` (just after a newline). Returns the new position. */
  const consumeHeredocs = (pos: number): number => {
    for (const h of pendingHeredocs) {
      const lines: string[] = [];
      while (pos < n) {
        let eol = source.indexOf('\n', pos);
        if (eol === -1) eol = n;
        const line = source.slice(pos, eol);
        pos = eol < n ? eol + 1 : n;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) break;
        lines.push(h.strip ? line.replace(/^\t+/, '') : line);
      }
      heredocBodies.push(lines.join('\n'));
    }
    pendingHeredocs = [];
    return pos;
  };

  /** Read one word starting at `i`. Returns the word, or null if nothing was read. */
  const readWord = (): Word | null => {
    let value = '';
    let quoted = false;
    let glob = false;
    let dollar = false;
    let any = false;
    while (i < n) {
      const c = source[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') break;
      if (c === '<' || c === '>') break;
      if (c === '#' && !any) {
        // comment to end of line
        while (i < n && source[i] !== '\n') i++;
        return null;
      }
      any = true;
      if (c === '\\') {
        if (i + 1 < n && source[i + 1] === '\n') {
          i += 2;
          continue;
        }
        if (i + 1 < n) {
          value += source[i + 1];
          quoted = true;
          i += 2;
        } else i++;
        continue;
      }
      if (c === "'") {
        const end = source.indexOf("'", i + 1);
        const body = source.slice(i + 1, end === -1 ? n : end);
        value += body;
        quoted = true;
        if (EXPANSION.test(body)) dollar = true;
        i = end === -1 ? n : end + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i++;
        while (i < n && source[i] !== '"') {
          const d = source[i]!;
          if (d === '\\' && i + 1 < n) {
            value += source[i + 1];
            i += 2;
            continue;
          }
          if (d === '$' && !EXPANDS.test(source[i + 1] ?? '')) {
            value += d;
            i++;
            continue;
          }
          if (d === '$') {
            dollar = true;
            i = readExpansion(i, (s) => (value += s));
            continue;
          }
          if (d === '`') {
            flag('subst');
            const end = source.indexOf('`', i + 1);
            value += source.slice(i, end === -1 ? n : end + 1);
            i = end === -1 ? n : end + 1;
            continue;
          }
          value += d;
          i++;
        }
        i++;
        continue;
      }
      if (c === '`') {
        flag('subst');
        const end = source.indexOf('`', i + 1);
        value += source.slice(i, end === -1 ? n : end + 1);
        i = end === -1 ? n : end + 1;
        continue;
      }
      if (c === '$') {
        if (source[i + 1] === "'") {
          // $'...' ANSI-C quoting: literal
          const end = source.indexOf("'", i + 2);
          value += source.slice(i + 2, end === -1 ? n : end);
          quoted = true;
          i = end === -1 ? n : end + 1;
          continue;
        }
        if (!EXPANDS.test(source[i + 1] ?? '')) {
          value += c;
          i++;
          continue;
        }
        dollar = true;
        i = readExpansion(i, (s) => (value += s));
        continue;
      }
      if (c === '{') {
        // brace expansion `{a,b}` / `{1..3}`; a bare `{` is a group keyword
        const end = source.indexOf('}', i + 1);
        const inner = end === -1 ? '' : source.slice(i + 1, end);
        if (end !== -1 && (inner.includes(',') || inner.includes('..')) && !/\s/.test(inner)) flag('brace');
        value += c;
        i++;
        continue;
      }
      if (c === '*' || c === '?' || c === '[') glob = true;
      value += c;
      i++;
    }
    if (value === '[' || value === '[[' || value === ']' || value === ']]') glob = false;
    return any ? { value, quoted, glob, dollar } : null;
  };

  /** From a `$` at `pos`, consume the expansion, flag it, append raw text. Returns the new position. */
  const readExpansion = (pos: number, append: (s: string) => void): number => {
    const next = source[pos + 1];
    if (next === '(') {
      flag('subst');
      const end = matchParen(source, pos + 1);
      append(source.slice(pos, end + 1));
      return end + 1;
    }
    if (next === '{') {
      flag('param');
      const end = source.indexOf('}', pos + 2);
      append(source.slice(pos, end === -1 ? n : end + 1));
      return end === -1 ? n : end + 1;
    }
    if (next !== undefined && VAR_START.test(next)) {
      flag('var');
      let e = pos + 1;
      if (/[A-Za-z_]/.test(next)) while (e < n && /[A-Za-z0-9_]/.test(source[e]!)) e++;
      else e = pos + 2;
      append(source.slice(pos, e));
      return e;
    }
    append('$');
    return pos + 1;
  };

  while (i < n) {
    const c = source[i]!;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && source[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      const end = i;
      i++;
      if (pendingHeredocs.length) i = consumeHeredocs(i);
      finishSegment(end);
      segStart = i;
      continue;
    }
    if (c === '&' && source[i + 1] === '&') {
      finishSegment(i);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === '|' && source[i + 1] === '|') {
      finishSegment(i);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === '|' && source[i + 1] === '&') {
      finishSegment(i);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === '|') {
      finishSegment(i);
      i++;
      segStart = i;
      continue;
    }
    if (c === ';') {
      finishSegment(i);
      i++;
      if (source[i] === ';') i++;
      segStart = i;
      continue;
    }
    if (c === '&' && source[i + 1] === '>') {
      // &> or &>>
      i += 2;
      let op = '&>';
      if (source[i] === '>') {
        op = '&>>';
        i++;
      }
      skipBlanks();
      redirects.push({ op, target: readWord() ?? undefined });
      continue;
    }
    if (c === '&') {
      flag('background');
      finishSegment(i);
      i++;
      segStart = i;
      continue;
    }
    if (c === '(') {
      if (source[i + 1] === '(') {
        flag('arith');
        const end = matchParen(source, i + 1);
        i = end + 2;
        continue;
      }
      flag('subshell');
      finishSegment(i);
      i++;
      segStart = i;
      continue;
    }
    if (c === ')') {
      finishSegment(i);
      i++;
      segStart = i;
      continue;
    }
    if (c === '<' || c === '>' || (/\d/.test(c) && (source[i + 1] === '<' || source[i + 1] === '>') && isWordStart(i))) {
      let fd: string | undefined;
      if (/\d/.test(c)) {
        fd = c;
        i++;
      }
      const r = readRedirectOp();
      if (r === '<<' || r === '<<-') {
        skipBlanks();
        const w = readWord();
        if (!w) {
          flag('heredoc_unquoted');
          continue;
        }
        if (!w.quoted) flag('heredoc_unquoted');
        pendingHeredocs.push({ delim: w.value, strip: r === '<<-' });
        redirects.push({ op: r, fd });
        continue;
      }
      if (r === '<(' || r === '>(') {
        flag('subst');
        const end = matchParen(source, i - 1);
        i = end + 1;
        continue;
      }
      skipBlanks();
      redirects.push({ op: r, fd, target: readWord() ?? undefined });
      continue;
    }
    const w = readWord();
    if (w) words.push(w);
  }
  if (pendingHeredocs.length) {
    // Heredoc opener on the last line with no body: still unquoted-body semantics.
    consumeHeredocs(n);
  }
  finishSegment(n);

  return { segments, scripts, syntax };

  function skipBlanks() {
    while (i < n && (source[i] === ' ' || source[i] === '\t')) i++;
  }

  function isWordStart(pos: number): boolean {
    return pos === 0 || /[\s;|&()]/.test(source[pos - 1]!);
  }

  /** At a `<` or `>`: consume the operator text. */
  function readRedirectOp(): string {
    const c = source[i]!;
    if (c === '<') {
      if (source.startsWith('<<<', i)) {
        i += 3;
        return '<<<';
      }
      if (source.startsWith('<<-', i)) {
        i += 3;
        return '<<-';
      }
      if (source.startsWith('<<', i)) {
        i += 2;
        return '<<';
      }
      if (source.startsWith('<&', i)) {
        i += 2;
        return '<&';
      }
      if (source.startsWith('<>', i)) {
        i += 2;
        return '<>';
      }
      if (source.startsWith('<(', i)) {
        i += 2;
        return '<(';
      }
      i++;
      return '<';
    }
    if (source.startsWith('>>', i)) {
      i += 2;
      return '>>';
    }
    if (source.startsWith('>&', i)) {
      i += 2;
      return '>&';
    }
    if (source.startsWith('>|', i)) {
      i += 2;
      return '>|';
    }
    if (source.startsWith('>(', i)) {
      i += 2;
      return '>(';
    }
    i++;
    return '>';
  }
}

/** Index of the `)` matching the `(` at `open`, quote-aware; `source.length - 1` when unbalanced. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = open; j < source.length; j++) {
    const c = source[j]!;
    if (quote) {
      if (c === '\\' && quote === '"') {
        j++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return source.length - 1;
}

function checkRedirect(r: Redirect, flag: (f: string) => void): void {
  const target = r.target?.value ?? '';
  if (/^\/dev\/(tcp|udp)\//.test(target)) {
    flag('redirect');
    return;
  }
  switch (r.op) {
    case '<':
    case '<&':
    case '<<<':
    case '<<':
    case '<<-':
      return;
    case '>&':
      if (OK_FD_TARGET.test(target) || target === '/dev/null' || target === '-') return;
      break;
    case '>':
    case '>>':
    case '&>':
    case '&>>':
    case '>|':
    case '<>':
      if (target === '/dev/null') return;
      break;
  }
  flag('redirect');
}

function buildSegment(text: string, words: Word[], flag: (f: string) => void): Segment | null {
  let idx = 0;
  const env: string[] = [];
  while (idx < words.length) {
    const w = words[idx]!;
    if (!w.quoted && ENV_ASSIGN.test(w.value)) {
      env.push(w.value.slice(0, w.value.indexOf('=')));
      idx++;
    } else break;
  }
  while (idx < words.length && words[idx]!.value === '!') idx++;
  while (idx < words.length && STRIP_PREFIX.has(words[idx]!.value)) {
    idx++;
    if (words[idx - 1]!.value === 'command' && words[idx]?.value === '-p') idx++;
  }
  if (idx >= words.length) {
    if (env.length === 0) return null;
    return { text, program: '', args: [], flags: [], env, globs: false, dollar: false, newline: false };
  }
  const first = words[idx]!;
  let program = first.value;
  if (!first.quoted || !/[\s]/.test(program)) program = program.slice(program.lastIndexOf('/') + 1);
  const rest = words.slice(idx + 1);
  const args = rest.map((w) => w.value);
  const flags = args.filter((a) => a.startsWith('-') && a.length > 1).map((a) => (a.startsWith('--') ? a.split('=')[0]! : a));
  const seg: Segment = {
    text,
    program,
    args,
    flags,
    env,
    globs: words.some((w) => w.glob),
    dollar: words.some((w) => w.dollar || EXPANSION.test(w.value)),
    newline: words.some((w) => w.value.includes('\n')),
  };
  if (KEYWORDS.has(program)) flag('compound');
  if (WRAPPERS.has(program)) seg.label = program;
  else if (SHELLS.has(program) && hasShortFlag(seg, 'c')) seg.label = `${program} -c`;
  return seg;
}

/** True when a short-flag cluster in `seg.flags` includes `letter` (e.g. `-lc` has `c`). */
export function hasShortFlag(seg: Segment, letter: string): boolean {
  return seg.flags.some((f) => !f.startsWith('--') && f.slice(1).includes(letter));
}

/** `-c`/`-e` bodies for shells and interpreters become scripts. */
function extractInline(seg: Segment, scripts: Script[]): void {
  const p = seg.program;
  const positional = seg.args.filter((a) => !a.startsWith('-') || a === '-');
  const body = (): string | undefined => positional[0];
  if (SHELLS.has(p) && hasShortFlag(seg, 'c')) {
    const b = body();
    if (b !== undefined) scripts.push({ lang: 'sh', body: b });
  } else if (/^python\d*(\.\d+)?$/.test(p) && hasShortFlag(seg, 'c')) {
    const b = body();
    if (b !== undefined) scripts.push({ lang: 'python', body: b });
  } else if ((p === 'node' || p === 'bun' || p === 'deno') && (hasShortFlag(seg, 'e') || hasShortFlag(seg, 'p') || seg.flags.includes('--eval') || seg.flags.includes('--print'))) {
    const b = body();
    if (b !== undefined) scripts.push({ lang: 'javascript', body: b });
  } else if ((p === 'ruby' || p === 'perl') && (hasShortFlag(seg, 'e') || hasShortFlag(seg, 'E'))) {
    const b = body();
    if (b !== undefined) scripts.push({ lang: p, body: b });
  } else if (p === 'php' && hasShortFlag(seg, 'r')) {
    const b = body();
    if (b !== undefined) scripts.push({ lang: 'php', body: b });
  }
}
