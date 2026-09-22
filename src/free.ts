// The free set: commands that run without asking Jev, mirroring the read-only
// rules of Claude Code 2.1.274 (see docs/plan-bash-guard.md, "Reference").
// Anything not listed here is not free. When in doubt this file says no; the
// cost of a false "free" is an unguarded command in bypass mode.
import { parseShell, type Segment, type Parsed } from './shell.ts';

/** Always read-only, any arguments (`yit`). */
export const CORE = new Set([
  'cal', 'uptime', 'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump', 'od', 'nl', 'id',
  'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc', 'basename', 'dirname', 'realpath',
  'cut', 'paste', 'tr', 'column', 'tac', 'rev', 'fold', 'expand', 'unexpand', 'fmt', 'comm', 'cmp',
  'numfmt', 'readlink', 'diff', 'true', 'false', 'sleep', 'which', 'type', 'expr', 'seq', 'tsort', 'pr',
]);

/** Programs allowed to carry an unquoted glob (`o8o`). */
export const GLOB_OK = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'grep', 'egrep', 'fgrep', 'diff', 'du', 'df', 'echo',
  'strings', 'hexdump', 'od', 'nl', 'cut', 'column', 'tr', 'tac', 'rev', 'cmp', 'basename', 'dirname',
  'realpath', 'readlink', 'sha256sum', 'sha1sum', 'md5sum', 'cd',
]);

/** Exact argv matches (`n8o`). */
const EXACT = new Set([
  'claude -h', 'claude --help', 'node -v', 'node --version', 'python --version', 'python3 --version', 'ip addr',
]);

/** Env prefixes that do not change what a command does (`Qle`). */
export const ENV_OK = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE', 'RUST_LOG', 'NODE_ENV',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS', 'LSCOLORS', 'GREP_COLOR', 'GREP_COLORS', 'GCC_COLORS',
  'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE', 'COLUMNS', 'LINES', 'CLICOLOR', 'CLICOLOR_FORCE', 'CI',
  'DEBIAN_FRONTEND', 'GIT_TERMINAL_PROMPT',
]);

/** git subcommands that only read (`ngt`); `branch`, `tag`, `config`, `remote`, `stash`, `worktree` get extra checks. */
export const GIT_READ = new Set([
  'diff', 'log', 'show', 'shortlog', 'reflog', 'ls-remote', 'status', 'blame', 'ls-files', 'merge-base',
  'rev-parse', 'rev-list', 'describe', 'cat-file', 'for-each-ref', 'grep', 'tag', 'branch', 'stash',
  'config', 'remote', 'worktree',
]);

const XARGS_TARGETS = new Set(['echo', 'printf', 'wc', 'grep', 'egrep', 'fgrep', 'head', 'tail']);
const XARGS_VALUE_OPTS = new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-R', '-J', '-i', '-l']);

type Rule = {
  /** Compare flags as written: the command uses single-dash long options (`find -delete`). */
  raw?: boolean;
  /** Every flag must be here. */
  allow?: Set<string>;
  /** No flag may be here. */
  forbid?: Set<string>;
  /** Extra per-command check on top of the flag rules. */
  check?: (seg: Segment) => string | undefined;
};

/** Expand `-abc` into `-a -b -c`; digits attached to a short flag are a value. `--x=y` is `--x`. */
export function expandFlags(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    if (f.startsWith('--')) out.push(f.split('=')[0]!);
    else if (/^-\d+$/.test(f)) out.push(f); // `-20` for head/tail
    else {
      for (const ch of f.slice(1)) {
        if (!/[A-Za-z]/.test(ch)) break;
        out.push('-' + ch);
      }
    }
  }
  return out;
}

function positionals(seg: Segment): string[] {
  return seg.args.filter((a) => !a.startsWith('-') || a === '-');
}

function forbidAny(...flags: string[]): Rule {
  return { forbid: new Set(flags) };
}

const SED_SAFE = new Set(['-n', '-E', '-r', '-e', '-s', '-u', '-z', '-l', '--posix', '--expression', '--regexp-extended',
  '--quiet', '--silent', '--separate', '--unbuffered', '--null-data', '--debug', '--sandbox', '--line-length', '--']);
/**
 * Walks a sed script and returns the reason it could write or execute, or
 * undefined. Grammar: [addr[,addr]][!] cmd. `w`/`W` write files, `e` runs a
 * command, `s///w` and `s///e` too; `r`/`R` only read.
 */
export function sedScriptReason(script: string): string | undefined {
  let i = 0;
  const n = script.length;
  const skipDelimited = (delim: string): boolean => {
    // at the char after the opening delimiter
    while (i < n) {
      const c = script[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === delim) {
        i++;
        return true;
      }
      i++;
    }
    return false;
  };
  const skipAddress = (): void => {
    if (i >= n) return;
    const c = script[i]!;
    if (c === '/') {
      i++;
      skipDelimited('/');
    } else if (c === '\\' && i + 1 < n) {
      const d = script[i + 1]!;
      i += 2;
      skipDelimited(d);
    } else if (/[0-9$]/.test(c)) {
      while (i < n && /[0-9$~+]/.test(script[i]!)) i++;
    } else return;
    // GNU `I`/`M` regex address flags
    while (i < n && /[IM]/.test(script[i]!)) i++;
  };
  while (i < n) {
    const c = script[i]!;
    if (/[\s;}]/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && script[i] !== '\n') i++;
      continue;
    }
    skipAddress();
    while (i < n && /[\s]/.test(script[i]!)) i++;
    if (script[i] === ',') {
      i++;
      while (i < n && /[\s]/.test(script[i]!)) i++;
      skipAddress();
      while (i < n && /[\s]/.test(script[i]!)) i++;
    }
    if (script[i] === '!') {
      i++;
      while (i < n && /[\s]/.test(script[i]!)) i++;
    }
    const cmd = script[i];
    if (cmd === undefined) break;
    i++;
    switch (cmd) {
      case 'w':
      case 'W':
        return `sed ${cmd} writes a file`;
      case 'e':
        return 'sed e runs a command';
      case 's':
      case 'y': {
        const delim = script[i];
        if (delim === undefined) return undefined;
        i++;
        if (!skipDelimited(delim)) return undefined;
        if (!skipDelimited(delim)) return undefined;
        // flags until ; } or newline; `w file` and `e` are the dangerous ones
        while (i < n && !/[;}\n]/.test(script[i]!)) {
          const f = script[i]!;
          if (f === 'w') return 'sed s///w writes a file';
          if (f === 'e') return 'sed s///e runs a command';
          if (f === ' ' || f === '\t') break;
          i++;
        }
        break;
      }
      case 'a':
      case 'i':
      case 'c':
      case 'r':
      case 'R':
      case 'b':
      case 't':
      case 'T':
      case ':':
        // text, filename or label runs to the end of the line
        while (i < n && script[i] !== '\n') i++;
        break;
      case 'q':
      case 'Q':
      case 'l':
      case 'L':
        while (i < n && /[0-9 ]/.test(script[i]!)) i++;
        break;
      case '{':
      case 'd':
      case 'D':
      case 'g':
      case 'G':
      case 'h':
      case 'H':
      case 'n':
      case 'N':
      case 'p':
      case 'P':
      case 'x':
      case 'z':
      case 'F':
      case '=':
        break;
      default:
        return `sed unknown command ${cmd}`;
    }
  }
  return undefined;
}

function sedScripts(seg: Segment): string[] {
  const out: string[] = [];
  let sawE = false;
  for (let k = 0; k < seg.args.length; k++) {
    const a = seg.args[k]!;
    if (a === '-e' || a === '--expression') {
      const v = seg.args[k + 1];
      if (v !== undefined) out.push(v);
      k++;
      sawE = true;
    } else if (a.startsWith('--expression=')) {
      out.push(a.slice('--expression='.length));
      sawE = true;
    } else if (a.startsWith('-') && a !== '-' && a.slice(1).includes('e') && !a.startsWith('--')) {
      sawE = true; // `-ne 'script'` puts the script next
      const v = seg.args[k + 1];
      if (v !== undefined) out.push(v);
      k++;
    }
  }
  if (!sawE) {
    const p = positionals(seg);
    if (p[0] !== undefined) out.push(p[0]);
  }
  return out;
}

const GIT_BRANCH_WRITE = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '-u', '-f', '--delete', '--move', '--copy', '--force',
  '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog']);
const GIT_TAG_WRITE = new Set(['-a', '-d', '-f', '-m', '-s', '-u', '-F', '--delete', '--annotate', '--sign', '--force',
  '--message', '--file', '--edit', '-e', '--cleanup', '--local-user']);
const GIT_LIST_FLAGS = new Set(['-l', '--list', '-a', '-r', '--all', '--remotes', '--contains', '--no-contains', '--merged',
  '--no-merged', '--points-at', '-v', '-vv', '--verbose', '--show-current', '-n', '--sort', '--format', '--column', '--no-column',
  '--color', '--no-color', '-i', '--ignore-case', '--omit-empty']);
const GIT_CONFIG_READ = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch', '--show-origin',
  '--show-scope', '--global', '--local', '--system', '--worktree', '-z', '--null', '--name-only', '--type', '--bool', '--int',
  '--default', '--includes', '--no-includes', '-f', '--file']);

function gitCheck(seg: Segment): string | undefined {
  // global options before the subcommand
  let k = 0;
  while (k < seg.args.length && seg.args[k]!.startsWith('-')) {
    const g = seg.args[k]!;
    if (g === '-c' || g === '--exec-path' || g.startsWith('--exec-path=') || g === '--config-env' || g.startsWith('--config-env=')) return `git ${g}`;
    if (g === '-C' || g === '--git-dir' || g === '--work-tree') k++;
    k++;
  }
  const sub = seg.args[k];
  if (sub === undefined) return 'git without subcommand';
  if (!GIT_READ.has(sub)) return `git ${sub}`;
  const rest = seg.args.slice(k + 1);
  const flags = expandFlags(rest.filter((a) => a.startsWith('-') && a.length > 1));
  const pos = rest.filter((a) => !a.startsWith('-'));
  if (flags.includes('--output')) return `git ${sub} --output`;
  if (flags.includes('--ext-diff') || flags.includes('--open-files-in-pager') || flags.includes('-O')) return `git ${sub} external tool`;
  switch (sub) {
    case 'ls-remote':
      if (flags.includes('-o') || flags.includes('--server-option')) return 'git ls-remote --server-option';
      if (pos.length > 0) return 'git ls-remote with operand';
      return undefined;
    case 'branch':
      if (flags.some((f) => GIT_BRANCH_WRITE.has(f))) return 'git branch write flag';
      if (pos.length > 0 && !flags.some((f) => GIT_LIST_FLAGS.has(f))) return 'git branch creates';
      return undefined;
    case 'tag':
      if (flags.some((f) => GIT_TAG_WRITE.has(f))) return 'git tag write flag';
      if (pos.length > 0 && !flags.some((f) => GIT_LIST_FLAGS.has(f))) return 'git tag creates';
      return undefined;
    case 'stash':
      if (pos[0] === 'list' || pos[0] === 'show') return undefined;
      return 'git stash write';
    case 'config':
      if (!flags.some((f) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch'].includes(f))) return 'git config write';
      if (!flags.every((f) => GIT_CONFIG_READ.has(f))) return 'git config flag';
      return undefined;
    case 'remote':
      if (pos.length === 0 || pos[0] === 'show' || pos[0] === 'get-url') return undefined;
      return `git remote ${pos[0]}`;
    case 'worktree':
      if (pos[0] === 'list') return undefined;
      return 'git worktree write';
    default:
      return undefined;
  }
}

/** `gh <cmd> <sub>` pairs Claude Code treats as read-only (`rgt`); `--web` opens a browser. */
const GH_READ = new Set(['pr view', 'pr list', 'pr status', 'pr checks', 'pr diff', 'issue view', 'issue list', 'issue status', 'repo view', 'run list', 'run view']);

function ghCheck(seg: Segment): string | undefined {
  const pos = positionals(seg);
  const pair = `${pos[0] ?? ''} ${pos[1] ?? ''}`;
  if (!GH_READ.has(pair)) return `gh ${pair.trim()}`.trim();
  return undefined;
}

function xargsCheck(seg: Segment): string | undefined {
  let k = 0;
  while (k < seg.args.length) {
    const a = seg.args[k]!;
    if (!a.startsWith('-')) break;
    if (XARGS_VALUE_OPTS.has(a)) k += 2;
    else k++;
  }
  const target = seg.args[k];
  if (target === undefined) return 'xargs without command';
  const base = target.slice(target.lastIndexOf('/') + 1);
  if (!XARGS_TARGETS.has(base)) return `xargs ${base}`;
  return undefined;
}

const RULES: Record<string, Rule> = {
  xargs: { check: xargsCheck },
  git: { check: gitCheck },
  gh: { forbid: new Set(['-w', '--web']), check: ghCheck },
  file: forbidAny('-C', '--compile', '-m', '--magic-file'),
  sed: {
    allow: SED_SAFE,
    check: (seg) => {
      for (const s of sedScripts(seg)) {
        const r = sedScriptReason(s);
        if (r) return r;
      }
      return undefined;
    },
  },
  sort: forbidAny('-o', '--output', '--compress-program'),
  man: forbidAny('-P', '--pager', '-H', '--html', '-B', '--browser', '-t', '-T', '-Z', '--troff', '--recode'),
  help: {},
  netstat: {},
  ps: {},
  base64: forbidAny('-o', '--output'),
  grep: { check: grepCheck },
  egrep: { check: grepCheck },
  fgrep: { check: grepCheck },
  rg: { forbid: new Set(['--pre', '--pre-glob']), check: grepCheck },
  sha256sum: {},
  sha1sum: {},
  md5sum: {},
  tree: forbidAny('-o'),
  date: {
    forbid: new Set(['-s', '--set']),
    check: (seg) => {
      // `-r`, `-d`, `-j`, `-v`, `-f`, `-I` take a value and only change what is displayed
      const flags = expandFlags(seg.flags);
      if (flags.some((f) => ['-r', '-d', '--date', '-j', '-v', '-f', '--file', '-I', '--iso-8601', '--reference'].includes(f))) return undefined;
      return positionals(seg).some((p) => !p.startsWith('+')) ? 'date sets the clock' : undefined;
    },
  },
  hostname: {
    forbid: new Set(['-b', '--boot', '-F', '--file']),
    check: (seg) => (positionals(seg).length ? 'hostname sets the name' : undefined),
  },
  lsof: {},
  pgrep: {},
  tput: {},
  ss: {},
  fd: forbidAny('-x', '--exec', '-X', '--exec-batch'),
  fdfind: forbidAny('-x', '--exec', '-X', '--exec-batch'),
  pyright: forbidAny('--createstub', '--writebaseline', '-w', '--watch'),
  docker: {
    check: (seg) => {
      const sub = positionals(seg)[0];
      return sub === 'ps' || sub === 'images' || sub === 'logs' || sub === 'inspect' ? undefined : `docker ${sub ?? ''}`.trim();
    },
  },
  test: {},
  '[': {},
  find: { raw: true, forbid: new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fls', '-fprintf', '-files0-from']) },
};

function grepCheck(seg: Segment): string | undefined {
  return seg.newline ? 'grep pattern with newline' : undefined;
}

/**
 * Paths whose contents are secrets. Claude Code's read-only rules let `cat` read
 * them; in bypass mode with `permissions.deny` emptied only Jev would notice, so
 * they leave the free set.
 */
export const SENSITIVE_PATH =
  /(^|[\/\s"'=])(\.env(?!\.(example|sample|template|dist|defaults?)\b)(\.[\w.-]+)?|\.envrc|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|\.kube|\.config\/gh|\.claude\/settings(\.local)?\.json|credentials(\.json)?|id_(rsa|ed25519|ecdsa|dsa)|\.keychain(-db)?|shadow|master\.key|service[-_]account[^\s]*\.json|secrets?\.(json|ya?ml|toml))($|[\/\s"'])|\.(pem|p12|pfx|jks|keystore)$/i;

const PRINTF_DIRECTIVE = /%[-+ #0]*\d*(?:\.\d+)?([a-zA-Z%])/g;
const PRINTF_SAFE = new Set(['s', 'd', 'i', 'u', 'x', 'X', 'o', 'c', 'q', 'b', 'f', 'e', 'g', '%']);

/** Why `seg` is not free, or undefined when it is. */
export function segmentReason(seg: Segment): string | undefined {
  if (seg.label && seg.label !== 'xargs') return `wrapper ${seg.label}`;
  for (const name of seg.env) if (!ENV_OK.has(name)) return `env ${name}`;
  const p = seg.program;
  if (!p) return 'no program';
  if (seg.dollar) return 'argument with $';
  if (seg.args.some((a) => SENSITIVE_PATH.test(a))) return 'sensitive path';
  if (seg.globs && !GLOB_OK.has(p)) return `glob with ${p}`;
  const argv = [p, ...seg.args].join(' ');
  if (EXACT.has(argv)) return undefined;
  if (CORE.has(p) || p === 'echo' || p === 'ls' || p === '[[' || p === 'history' || p === 'arch' || p === 'ifconfig') return undefined;
  if (p === 'cd') return positionals(seg).length <= 1 ? undefined : 'cd with several operands';
  if (p === 'pwd' || p === 'whoami' || p === 'alias') return seg.args.length === 0 ? undefined : `${p} with arguments`;
  if (p === 'printf') {
    const fmt = positionals(seg)[0] ?? '';
    for (const m of fmt.matchAll(PRINTF_DIRECTIVE)) if (!PRINTF_SAFE.has(m[1]!)) return 'printf directive';
    return undefined;
  }
  const rule = RULES[p];
  if (!rule) return `${p} not in free set`;
  const flags = rule.raw ? seg.flags : expandFlags(seg.flags);
  if (rule.allow && !flags.every((f) => rule.allow!.has(f))) return `${p} flag ${flags.find((f) => !rule.allow!.has(f))}`;
  if (rule.forbid) {
    const hit = flags.find((f) => rule.forbid!.has(f));
    if (hit) return `${p} ${hit}`;
  }
  return rule.check?.(seg);
}

export type FreeCheck = { free: boolean; reason?: string; parsed: Parsed };

/** Why `command` is not free, with the parse so callers do not split twice. */
export function checkFree(command: string): FreeCheck {
  const parsed = parseShell(command);
  if (command.length > 2000) return { free: false, reason: 'too long', parsed };
  if (parsed.syntax.length) return { free: false, reason: `syntax ${parsed.syntax[0]}`, parsed };
  if (parsed.segments.length === 0) return { free: false, reason: 'empty', parsed };
  const cds = parsed.segments.filter((s) => s.program === 'cd').length;
  if (cds > 1) return { free: false, reason: 'several cd', parsed };
  if (cds === 1 && parsed.segments.some((s) => s.program === 'git')) return { free: false, reason: 'cd with git', parsed };
  for (const seg of parsed.segments) {
    const r = segmentReason(seg);
    if (r) return { free: false, reason: r, parsed };
  }
  return { free: true, parsed };
}

/** True when every segment is in the free set and nothing about the syntax disqualifies it. */
export function isFree(command: string): boolean {
  return checkFree(command).free;
}
