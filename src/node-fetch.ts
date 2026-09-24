// Node's fetch for the command hooks, with a hard timeout and call timings.
// Kept out of jev.ts: the function-hook module imports that and must not reach node: modules.
import dc from 'node:diagnostics_channel';
import type { FetchLike } from './jev.ts';

/** Where a Jev call's time went, filled in by `nodeFetch` across its tries. */
export type Trace = { startedAt?: number; connectMs: number; serverMs?: number; tries: number };

export const newTrace = (): Trace => ({ connectMs: 0, tries: 0 });

/**
 * Log fields for a trace; `t0` is when the hook started building the request. Empty if no request went out.
 * `startMs`: from node's start to `t0` (boot and module load), which `ms` leaves out.
 */
export function traceFields(trace: Trace, t0: number): { startMs?: number; prepMs?: number; connectMs?: number; serverMs?: number } {
  if (trace.startedAt === undefined) return {};
  return { startMs: Math.round(t0 - performance.timeOrigin), prepMs: trace.startedAt - t0, connectMs: trace.connectMs, ...(trace.serverMs !== undefined ? { serverMs: trace.serverMs } : {}) };
}

/** Node fetch with a hard timeout; the hook must never hang Claude Code. */
export function nodeFetch(timeoutMs: number, trace?: Trace): FetchLike {
  return async (url, init) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let connectAt = 0;
    const onConnect = () => { connectAt = Date.now(); };
    const onConnected = () => { if (trace && connectAt) trace.connectMs += Date.now() - connectAt; };
    if (trace) {
      trace.tries++;
      trace.startedAt ??= Date.now();
      dc.subscribe('undici:client:beforeConnect', onConnect);
      dc.subscribe('undici:client:connected', onConnected);
    }
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      // the gateway's wait on Jev, the closest to Jev's own processing time
      const server = Number(r.headers.get('x-envoy-upstream-service-time'));
      if (trace && r.headers.has('x-envoy-upstream-service-time') && Number.isFinite(server)) trace.serverMs = server;
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
      return { status: r.status, ok: r.ok, text: await r.text(), headers };
    } finally {
      clearTimeout(t);
      if (trace) {
        dc.unsubscribe('undici:client:beforeConnect', onConnect);
        dc.unsubscribe('undici:client:connected', onConnected);
      }
    }
  };
}
