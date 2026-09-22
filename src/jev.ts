// Minimal client for TypeSafe AI's System One (Jev) endpoint.
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
};
export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
};
export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  /** Level descriptions, lowest first; 2 to 10 of them. */
  criteria: string[];
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: 'score';
  /** Probability-weighted position, 0-based, may fall between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
};

export type FetchInit = { method: string; headers: Record<string, string>; body: string };
export type FetchResult = { status: number; ok: boolean; text: string };
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResult>;

export type ClientOptions = { apiKey: string; model?: string; url?: string };

export function buildRequest(
  opts: ClientOptions,
  state: unknown,
  questions: Questions,
): { url: string; init: FetchInit } {
  return {
    url: opts.url ?? JEV_URL,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: opts.model ?? DEFAULT_MODEL, state, questions }),
    },
  };
}

export function parseResponse(res: FetchResult): JevResponse {
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { answers?: unknown }).answers !== 'object'
  ) {
    throw new Error('Jev response has no answers');
  }
  return parsed as JevResponse;
}

export async function ask(
  fetchLike: FetchLike,
  opts: ClientOptions,
  state: unknown,
  questions: Questions,
): Promise<JevResponse> {
  const { url, init } = buildRequest(opts, state, questions);
  return parseResponse(await fetchLike(url, init));
}

export function noul(res: JevResponse, name: string): number {
  const a = res.answers[name];
  if (!a || a.type !== 'noul' || !Number.isFinite(a.noul)) {
    throw new Error(`Jev: missing noul answer "${name}"`);
  }
  return a.noul;
}

/** Node fetch with a hard timeout; the hook must never hang Claude Code. */
export function nodeFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      return { status: r.status, ok: r.ok, text: await r.text() };
    } finally {
      clearTimeout(t);
    }
  };
}

/** Character-based token estimate, deliberately pessimistic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** The score answer's position, or throws when the answer is missing or not a score. */
export function score(res: JevResponse, name: string): number {
  const a = res.answers[name];
  if (!a || a.type !== 'score' || typeof a.score !== 'number') throw new Error(`Jev answer ${name} missing or not a score`);
  return a.score;
}
