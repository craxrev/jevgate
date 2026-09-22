export async function readStdinJson<T = Record<string, unknown>>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return (text ? JSON.parse(text) : {}) as T;
}

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}
