import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, noul, ask, estimateTokens, type FetchLike } from '../src/jev.ts';

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
