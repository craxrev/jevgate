// The file guard: Edit/Write/Read and friends. Inside the project nothing is
// asked. A write outside it gets the file facts from facts.ts (one Jev call); a
// read of a secret path is refused locally. Paths are the whole story here, so
// most calls cost nothing.
import { resolve, isAbsolute } from 'node:path';
import { SENSITIVE_PATH } from './free.ts';

export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'] as const;
export type FileTool = (typeof FILE_TOOLS)[number];
export const WRITE_TOOLS = new Set<string>(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export type FileInput = {
  file_path?: string;
  notebook_path?: string;
  content?: string;
  new_string?: string;
  new_source?: string;
  edits?: { new_string?: string }[];
};

/** The path a file tool acts on, or undefined when the input has none. */
export function toolPath(input: FileInput | undefined): string | undefined {
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === 'string' && p.trim() ? p : undefined;
}

/** The first `max` characters of what a write tool would put on disk. */
export function contentHead(input: FileInput | undefined, max = 400): string | undefined {
  if (!input) return undefined;
  const text = input.content ?? input.new_string ?? input.new_source ?? input.edits?.map((e) => e.new_string ?? '').join('\n');
  if (typeof text !== 'string' || !text) return undefined;
  return text.length > max ? text.slice(0, max) + ' […]' : text;
}

/** Absolute, `~`-expanded, resolved against `cwd` when relative. */
export function resolvePath(p: string, cwd: string | undefined, home: string | undefined): string {
  let out = p;
  if (out === '~' || out.startsWith('~/')) out = (home ?? '') + out.slice(1);
  if (!isAbsolute(out)) out = resolve(cwd ?? '/', out);
  return resolve(out);
}

// session scratchpads, and the per-job temp dirs Claude Code keeps under ~/.claude/jobs
const SCRATCHPAD = /^\/(private\/)?tmp\/claude(-\d+)?\/|\/\.claude\/jobs\/[^/]+\/tmp\//;

function under(path: string, root: string | undefined): boolean {
  if (!root) return false;
  const r = root.endsWith('/') ? root : root + '/';
  return path === root || path.startsWith(r);
}

/** Inside the repository (or `cwd` when there is none) or a session scratchpad. */
export function insideProject(absPath: string, repoRoot: string | undefined, cwd: string | undefined): boolean {
  return under(absPath, repoRoot ?? cwd) || SCRATCHPAD.test(absPath);
}

export function isSensitivePath(absPath: string): boolean {
  return SENSITIVE_PATH.test(absPath);
}

/** What Jev sees for a write outside the project. */
export type FileState = {
  /** `<tool> <path>`, so the shared fact texts can speak of "the command". */
  command: string;
  tool: string;
  /** Absolute path the tool writes. */
  path: string;
  cwd?: string;
  repo_root?: string;
  /** Whether `path` already exists: a Write over it replaces the file. */
  exists: boolean;
  /** Start of the new content, or of the replacement text for an edit. */
  content_head?: string;
  home?: string;
  recent?: { role: 'user' | 'assistant'; text: string }[];
};

export const SECRET_READ_REASON = 'jevgate: denied · exposes_secret (path holds credentials)';
