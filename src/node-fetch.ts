// Node's fetch for the probe scripts, with a hard timeout. The guards call Jev
// through the module's `$.http.fetch`; this file is kept out of jev.ts, which the
// module imports and which must not reach node: modules.
import type { FetchLike } from './jev.ts';

/** Node fetch that gives up after `timeoutMs`. */
export function nodeFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (k !== 'set-cookie') headers[k] = v;
      });
      return { status: r.status, ok: r.ok, text: await r.text(), headers };
    } finally {
      clearTimeout(t);
    }
  };
}
