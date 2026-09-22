// Function hook (early access): replace the compaction summary with the same
// messages, long tool outputs truncated. Text is never rewritten, calls are
// never dropped. Jev only ranks which truncated outputs to restore verbatim.
import type { On, PluginOptions, Register, SessionMessage } from 'claude-code';
import { fromRaw, type Config } from '../src/config.ts';
import { ask, noul, type FetchLike } from '../src/jev.ts';
import {
  candidates,
  apply,
  reductionRatio,
  buildRankState,
  rankQuestions,
  pickRestore,
  type Msg,
} from '../src/compact-core.ts';

type Host = Parameters<Parameters<On>[1]>[0];

async function resolveApiKey($: Host, cfg: Config): Promise<string | undefined> {
  if (cfg.apiKey) return cfg.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const v = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function hostFetch($: Host): FetchLike {
  return async (url, init) => {
    const r = await $.http.fetch(url, init);
    return { status: r.status, ok: r.ok, text: r.text };
  };
}

/** Maps rebuilt messages back onto the engine's shape; untouched ones keep their handle. */
function toSession(input: readonly SessionMessage[], output: readonly Msg[]): SessionMessage[] {
  const own = new Set<Msg>(input as readonly Msg[]);
  return output.map((m) => (own.has(m) ? (m as SessionMessage) : (m as SessionMessage)));
}

export const register: Register = (on: On, options: PluginOptions) => {
  const cfg = fromRaw(options as Record<string, string | number | boolean | readonly string[]>);
  let compacting = false;

  on('session.compact', async ($, e, next) => {
    if (!cfg.compactEnabled) return next(e);
    const t0 = Date.now();
    try {
      const messages = e.messages as readonly Msg[];
      const cands = candidates(messages, {
        preserveRecent: cfg.compactPreserveRecent,
        headChars: cfg.compactTruncateHeadChars,
      });
      if (cands.length === 0) {
        $.ui.log('jevgate compact: nothing to truncate, built-in summary');
        return next(e);
      }

      const truncate = new Set(cands.map((c) => c.id));
      let restored = 0;
      if (cfg.compactUseJev) {
        const apiKey = await resolveApiKey($, cfg);
        if (apiKey) {
          const state = buildRankState(messages, cands, cfg.compactTruncateHeadChars);
          const res = await ask(hostFetch($), { apiKey, model: cfg.model }, state, rankQuestions(cands));
          const scores = new Map<string, number>();
          for (const c of cands) scores.set(c.id, noul(res, `keep_${c.id}`));
          const keep = pickRestore(scores, cfg.compactRestoreTopK, cfg.compactRestoreMinScore);
          for (const id of keep) truncate.delete(id);
          restored = keep.size;
          $.ui.log(
            'jevgate compact scores: ' +
              cands.map((c) => `${c.tool}:${(scores.get(c.id) ?? 0).toFixed(2)}${keep.has(c.id) ? '*' : ''}`).join(' '),
          );
        } else {
          $.ui.log('jevgate compact: no TYPESAFE_API_KEY, deterministic truncation only');
        }
      }

      const out = apply(messages, truncate, cfg.compactTruncateHeadChars);
      const ratio = reductionRatio(messages, out);
      const summary = `${truncate.size} truncated, ${restored} restored, ${Math.round(ratio * 100)}% smaller, ${Date.now() - t0}ms`;
      if (ratio < cfg.compactMinReductionRatio) {
        $.ui.toast(`jevgate: built-in summary (only ${summary})`, { timeoutMs: 8000 });
        return next(e);
      }
      $.ui.toast(`jevgate: kept all ${out.length} messages, no summary (${summary})`, { timeoutMs: 8000 });
      return { messages: toSession(e.messages, out) };
    } catch (err) {
      $.ui.toast(`jevgate: built-in summary (${err instanceof Error ? err.message : String(err)})`, { timeoutMs: 8000 });
      return next(e);
    }
  });

  on('turn.complete', async ($, e, next) => {
    if (!cfg.compactEnabled || compacting) return next(e);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) >= cfg.compactAtPercent) {
        compacting = true;
        await $.session.compact();
      }
    } catch (err) {
      $.ui.log(`jevgate: early compact skipped (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      compacting = false;
    }
    return next(e);
  });
};
