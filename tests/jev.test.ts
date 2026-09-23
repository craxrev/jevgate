import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, noul, ask, estimateTokens, JevBlockedError, JevTransientError, type FetchLike } from '../src/jev.ts';

test('buildRequest shapes the System One request', () => {
  const { url, init } = buildRequest({ apiKey: 'k' }, { a: 1 }, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer k');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { a: 1 });
  assert.equal(body.questions.q.type, 'noul');
});

test('parseResponse rejects errors and malformed bodies', () => {
  assert.throws(() => parseResponse({ status: 401, ok: false, text: 'nope' }), /HTTP 401/);
  assert.throws(() => parseResponse({ status: 200, ok: true, text: '{' }), /malformed/);
  assert.throws(() => parseResponse({ status: 200, ok: true, text: '{"model":"x"}' }), /no answers/);
});

test('noul reads a probability and rejects missing ones', () => {
  const res = parseResponse({ status: 200, ok: true, text: '{"model":"j","answers":{"a":{"type":"noul","noul":0.42}}}' });
  assert.equal(noul(res, 'a'), 0.42);
  assert.throws(() => noul(res, 'b'), /missing noul/);
});

test('ask goes through the injected fetch', async () => {
  let seen = '';
  const f: FetchLike = async (url, init) => {
    seen = url + ' ' + init.body;
    return { status: 200, ok: true, text: '{"model":"j","answers":{}}' };
  };
  const res = await ask(f, { apiKey: 'k', model: 'jev-1.13.0' }, 's', {});
  assert.equal(res.model, 'j');
  assert.match(seen, /jev-1\.13\.0/);
});

test('estimateTokens is pessimistic', () => {
  assert.ok(estimateTokens('a'.repeat(350)) >= 100);
});

test('a gateway HTML 403 is a block, 429 and 5xx are transient', () => {
  assert.throws(() => parseResponse({ status: 403, ok: false, text: '<!DOCTYPE html><html>' }), JevBlockedError);
  assert.throws(() => parseResponse({ status: 403, ok: false, text: '{"detail":"bad key"}' }), (e) => !(e instanceof JevBlockedError));
  assert.throws(() => parseResponse({ status: 429, ok: false, text: '' }), JevTransientError);
  assert.throws(() => parseResponse({ status: 502, ok: false, text: '' }), JevTransientError);
});

test('ask retries once after a transient failure, never after a block', async () => {
  const ok = { status: 200, ok: true, text: '{"model":"j","answers":{}}' };
  const seq = (...rs: (typeof ok | Error)[]): { f: FetchLike; calls: () => number } => {
    let i = 0;
    return {
      f: async () => {
        const r = rs[i++]!;
        if (r instanceof Error) throw r;
        return r;
      },
      calls: () => i,
    };
  };
  const a = seq({ status: 503, ok: false, text: '' }, ok);
  const retried = await ask(a.f, { apiKey: 'k' }, 's', {});
  assert.equal(retried.model, 'j');
  assert.equal(retried.retried, true);
  assert.equal(a.calls(), 2);
  const b = seq(new Error('aborted'), ok);
  await ask(b.f, { apiKey: 'k' }, 's', {});
  assert.equal(b.calls(), 2);
  assert.equal((await ask(seq(ok).f, { apiKey: 'k' }, 's', {})).retried, undefined);
  const c = seq({ status: 403, ok: false, text: '<html>' }, ok);
  await assert.rejects(ask(c.f, { apiKey: 'k' }, 's', {}), JevBlockedError);
  assert.equal(c.calls(), 1);
  const d = seq({ status: 500, ok: false, text: '' }, { status: 500, ok: false, text: '' });
  await assert.rejects(ask(d.f, { apiKey: 'k' }, 's', {}), JevTransientError);
  const e = seq({ status: 500, ok: false, text: '' }, ok);
  await assert.rejects(ask(e.f, { apiKey: 'k', retries: 0 }, 's', {}), JevTransientError);
  assert.equal(e.calls(), 1);
});
