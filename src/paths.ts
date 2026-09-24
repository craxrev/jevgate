// POSIX path helpers without node:path, which the function-hook module may not import.

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** Joins the segments right to left until one is absolute, then drops `.` and `..`, as node's `path.resolve` does (no cwd fallback: the first segment should be absolute). */
export function resolve(...segments: string[]): string {
  let joined = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (!s) continue;
    joined = joined ? `${s}/${joined}` : s;
    if (isAbsolute(s)) break;
  }
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}
