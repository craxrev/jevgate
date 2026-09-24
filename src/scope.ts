// Where Claude Code lets a read-only command or a file edit through in auto
// mode without its classifier: under the folder the session started in (a
// shell `cd` does not move it), the session's own scratchpad, and the
// directories added to it. Probed on 2.1.282: a path anywhere else, `/tmp`, `~`,
// `..` above the start, another session's scratchpad, goes to the classifier.
import { resolvePath } from './file-policy.ts';
import type { Parsed, Segment } from './shell.ts';

export type Scope = {
  /** The shell's folder now: relative paths resolve against it. */
  cwd: string;
  /** Folders a path may be under: where the session started, and the added directories. */
  roots: readonly string[];
  /** The session id, for its own scratchpad (`/tmp/claude-<uid>/<project>/<session>/scratchpad`). */
  session?: string;
  home?: string;
};

function under(path: string, root: string): boolean {
  const r = root.endsWith('/') ? root.slice(0, -1) : root;
  return path === r || path.startsWith(r + '/');
}

function ownScratchpad(path: string, session: string | undefined): boolean {
  if (!session) return false;
  const esc = session.replace(/[^A-Za-z0-9-]/g, '');
  return new RegExp(`^/(private/)?tmp/claude-\\d+/[^/]+/${esc}/scratchpad(/|$)`).test(path);
}

/** Whether the absolute `path` is where Claude Code lets things through. */
export function inScope(path: string, scope: Scope): boolean {
  return scope.roots.some((r) => under(path, r)) || ownScratchpad(path, scope.session);
}

/**
 * The words of a segment that could name a path: its arguments, and the value
 * of a `--name=value` flag. A bare word resolves under the shell's folder and so
 * never leaves; only `/…`, `~…` and `..` can.
 */
function pathWords(seg: Segment): string[] {
  const out: string[] = [];
  for (const a of seg.args) {
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.push(a.slice(eq + 1));
    } else out.push(a);
  }
  return out.filter((w) => w.startsWith('/') || w.startsWith('~') || w === '..' || w.startsWith('../') || w.includes('/../') || w.endsWith('/..'));
}

/**
 * The first word of a command naming a path outside `scope`, or undefined.
 * A `cd` moves where the segments after it resolve; `cd` alone goes home.
 */
export function outsidePath(parsed: Parsed, scope: Scope): string | undefined {
  let base = scope.cwd;
  for (const seg of parsed.segments) {
    for (const w of pathWords(seg)) {
      if (!inScope(resolvePath(w, base, scope.home), scope)) return w;
    }
    if (seg.program === 'cd') {
      const target = seg.args.find((a) => !a.startsWith('-'));
      const to = target === undefined ? scope.home : resolvePath(target, base, scope.home);
      if (!to || !inScope(to, scope)) return target ?? '~';
      base = to;
    }
  }
  return undefined;
}
