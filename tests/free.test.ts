import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFree, checkFree, expandFlags, sedScriptReason } from '../src/free.ts';

const free = (cases: string[]) => {
  for (const c of cases) assert.equal(isFree(c), true, `${c} should be free: ${checkFree(c).reason}`);
};
const notFree = (cases: [string, RegExp][]) => {
  for (const [c, why] of cases) {
    const r = checkFree(c);
    assert.equal(r.free, false, `${c} should not be free`);
    assert.match(r.reason ?? '', why, c);
  }
};

test('core list and special cases are free with any arguments', () => {
  free([
    'git status', 'git diff HEAD --stat', 'git log --oneline -20', 'git show HEAD:file', 'git blame -L 1,5 f',
    'ls -la src/', 'cat package.json', 'head -20 f', 'tail -f log', 'wc -l f', 'diff a b', 'which node', 'sleep 2',
    'echo hi', 'pwd', 'whoami', 'cd src', 'cd', 'true', 'uname -a', 'du -sh .', 'df -h', 'stat f', 'realpath .',
    'node -v', 'node --version', 'python3 --version', 'claude --help', '[[ -f x ]]', 'test -f x', '[ -f x ]',
    'printf "%s\\n" a b', 'ls | wc -l | tr -d " "', 'grep -rn "TODO" src/ | head -50', 'rg foo src', 'fd foo',
    'find . -name "*.ts" -not -path "*/node_modules/*"', 'sed -n 1,40p src/index.ts', "sed -n 's/a/b/p' f", 'sort f | head',
    'date', 'date +%s', 'hostname', 'docker ps', 'docker logs x', 'ps aux', 'lsof -i :3000', 'pgrep node', 'tree -L 2', 'file x',
    'xargs -0 grep foo', 'xargs wc -l', 'NODE_ENV=test ls', 'CI=1 git status', 'command ls', 'ls 2>/dev/null', 'ls >/dev/null 2>&1',
    "cat <<'EOF'\nhi\nEOF", 'ls src/*.ts', 'cat *.md', 'cat ~/notes.txt', 'git branch', 'git branch -a', 'git branch --show-current',
    'git tag', 'git tag -l "v*"', 'git stash list', 'git stash show -p', 'git config --get user.name', 'git config --list',
    'git remote', 'git remote -v', 'git remote show origin', 'git worktree list', 'git rev-parse --show-toplevel', 'git ls-files',
    'git log -p -- src', 'git diff main...HEAD', 'git -C /tmp/x status', 'sha256sum f', 'base64 f', 'md5sum f',
  ]);
});

test('anything not listed is not free', () => {
  notFree([
    ['npm test', /npm not in free set/], ['npm test 2>&1 | tail -20', /npm/], ['node x.js', /node/], ['python3 x.py', /python3/],
    ['awk "{print}" f', /awk/], ['jq . f', /jq/], ['uniq f', /uniq/], ['curl https://x', /curl/],
    ['rm -rf dist', /rm/], ['mkdir x', /mkdir/], ['touch x', /touch/], ['npx tsc', /npx/], ['printenv', /printenv/], ['make', /make/],
  ]);
});

test('syntax findings disqualify the whole command', () => {
  notFree([
    ['wc -l $(git ls-files "*.ts")', /syntax subst/], ['echo $HOME', /syntax var/], ['echo ${X}', /syntax param/],
    ['(ls)', /syntax subshell/], ['sleep 5 &', /syntax background/], ['echo {a,b}', /syntax brace/],
    ['for f in a; do ls; done', /syntax compound/], ['cat <<EOF\nhi\nEOF', /heredoc_unquoted/], ['echo hi > out.txt', /syntax redirect/],
    ['ls 2> err.log', /redirect/], ['', /empty/],
  ]);
});

test('compound rules: several cd, cd with git', () => {
  notFree([['cd a; cd b', /several cd/], ['cd x && git status', /cd with git/]]);
  free(['cd x && ls', 'cd x; cat f | head']);
});

test('wrappers, env prefixes, dollars, globs', () => {
  notFree([
    ['timeout 5 ls', /wrapper timeout/], ['env ls', /wrapper env/], ['sudo ls', /wrapper sudo/], ['nohup ls', /wrapper nohup/],
    ['time ls', /wrapper time/], ['sh -c "ls"', /wrapper sh -c/], ['bash -lc ls', /wrapper bash -c/],
    ['FOO=1 ls', /env FOO/], ['PATH=/x ls', /env PATH/], ["grep '\\$x' f", /argument with \$/], ['sleep *', /glob with sleep/],
    ['find . -name *.ts', /glob with find/], ['xargs rm', /xargs rm/], ['xargs -I {} cp {} /tmp', /xargs cp/], ['xargs', /xargs without/],
  ]);
});

test('git: write subcommands, write flags, dangerous global options', () => {
  notFree([
    ['git push origin main', /git push/], ['git commit -m x', /git commit/], ['git add -A', /git add/], ['git reset --hard', /git reset/],
    ['git checkout -- .', /git checkout/], ['git clean -fd', /git clean/], ['git branch foo', /git branch creates/], ['git branch -d foo', /write flag/],
    ['git branch -u origin/main', /write flag/], ['git tag v1', /git tag creates/], ['git tag -d v1', /write flag/], ['git stash', /stash write/],
    ['git stash pop', /stash write/], ['git config user.name x', /config write/], ['git config --unset x', /config write/],
    ['git remote add o url', /git remote add/], ['git remote set-url origin x', /git remote set-url/], ['git worktree add x', /worktree write/],
    ['git -c core.pager=cat log', /git -c/], ['git --exec-path=/x log', /exec-path/], ['git diff --output=x', /--output/],
    ['git log --output x', /--output/], ['git ls-remote -o x origin', /server-option/], ['git ls-remote origin', /ls-remote with operand/], ['git grep -O foo', /external tool/], ['git', /without subcommand/],
  ]);
});

test('flag-gated commands', () => {
  notFree([
    ['sed -i s/a/b/ f.txt', /sed flag -i/], ['sed -i.bak s/a/b/ f', /sed flag -i/], ['sed --in-place s/a/b/ f', /sed flag --in-place/],
    ['sed -f script.sed f', /sed flag -f/], ["sed -n 's/a/b/w out' f", /s\/\/\/w writes/], ["sed 'w out' f", /sed w writes/],
    ["sed -e '1e ls' f", /sed e runs/], ['sort -o x y', /sort -o/], ['sort --output=x y', /sort --output/],
    ['find . -delete', /find -delete/], ['find . -exec rm {} \;', /find -exec/], ['find . -fprint x', /find -fprint/],
    ['rg --pre cat x', /rg --pre/], ['fd -x rm', /fd -x/], ['fd --exec rm', /fd --exec/], ['file -C x', /file -C/], ['tree -o x', /tree -o/],
    ['date 1200', /date sets/], ['date -s x', /date -s/], ['hostname foo', /hostname sets/], ['docker run x', /docker run/],
    ['docker exec -it c sh', /docker exec/], ['base64 -o x f', /base64 -o/], ['man -P sh ls', /man -P/], ['pyright --createstub x', /pyright --createstub/],
    ['printf "%n" a', /printf directive/], ['pwd x', /pwd with arguments/], ['cd a b', /cd with several/], ['grep -e "a\nb" f', /newline/],
  ]);
});

test('gh: only the read-only view/list pairs, never --web', () => {
  free(['gh pr list --state open', 'gh pr view 42', 'gh pr checks 42', 'gh pr diff 42', 'gh issue list', 'gh repo view', 'gh run list', 'gh run view 123 --log', 'git ls-remote', 'git ls-remote --heads']);
  notFree([
    ['gh pr create --fill', /gh pr create/], ['gh pr merge 42', /gh pr merge/], ['gh api repos/x/y', /gh api/], ['gh pr view 42 --web', /gh --web/],
    ['gh pr view -w 42', /gh -w/], ['gh auth token', /gh auth token/], ['gh', /gh/], ['gh release create v1', /gh release create/],
  ]);
});

test('secret paths leave the free set so Jev judges them', () => {
  notFree([
    ['cat .env', /sensitive/], ['cat .env.local', /sensitive/], ['cat ~/.ssh/id_rsa', /sensitive/], ['ls ~/.ssh', /sensitive/],
    ['cat ~/.aws/credentials', /sensitive/], ['grep foo .env.production', /sensitive/], ['cat ~/.claude/settings.json', /sensitive/],
    ['cat secrets.yaml', /sensitive/], ['head -5 key.pem', /sensitive/], ['cat ~/.netrc', /sensitive/], ['cat .envrc', /sensitive/],
  ]);
  free(['cat environment.ts', 'ls environments/', 'cat src/config.ts', 'grep -r ENV src/', 'cat .env.example', 'cat .env.sample']);
});

test('sed scripts: regex ranges and prints are fine, w/W/e are not', () => {
  free([
    "sed -n '/Cover art and tagging/,/LLM assist, second pass/p' f", "sed -n '/^### Why pages inside the window/,/^### Notes/p' SPEC.md",
    "sed -n '/^class A/,/^class B/p' f", 'sed -n 60,140p f', "sed -E 's/(a|b)/[\\1]/g' f", "sed '1d' f",
    "sed -n '/x/{p;q}' f", "sed 's|a/b|c|' f", "sed -n '/we/p' f", "sed 's/e/w/' f", "sed -e 's/a/b/' -e 's/c/d/' f", "sed -n 'l' f", "sed = f",
  ]);
  // a `$` that could expand, in any argument of a flag-gated command, is rejected before the script is read;
  // one that cannot (an anchor before `/` or `"`, a trailing `$`) is literal
  notFree([["sed -n '$p' f", /argument with \$/], ['grep "$x" f', /syntax var/]]);
  free(["sed 's/ *{$//' f", 'sed -n 840,915p a.d.ts | grep -vE "^\\s*\\*\\s*$"', "grep -c 'x$' f"]);
  assert.equal(sedScriptReason('s/ *{$//'), undefined);
  assert.equal(sedScriptReason('$p'), undefined);
  assert.equal(sedScriptReason('1d;$d'), undefined);
  assert.equal(sedScriptReason('s/a/b/gI'), undefined);
  assert.match(sedScriptReason('s/a/b/w out') ?? '', /w writes/);
  assert.match(sedScriptReason('/x/w out') ?? '', /w writes/);
  assert.match(sedScriptReason('1,5W out') ?? '', /W writes/);
  assert.match(sedScriptReason('e ls') ?? '', /e runs/);
  assert.match(sedScriptReason('s/a/ls/e') ?? '', /e runs/);
  assert.match(sedScriptReason('/x/,/y/{s/a/b/;w out}') ?? '', /w writes/);
  assert.equal(sedScriptReason('r file'), undefined);
  assert.equal(sedScriptReason('a\\\ntext'), undefined);
  assert.match(sedScriptReason('v') ?? '', /unknown/);
});

test('date display flags with values are not clock settings', () => {
  free(['date -r 1788561805', 'date -d "2 days ago"', 'date -u +%Y', 'date -j -f "%Y" 2024']);
  notFree([['date 1200', /date sets/], ['date --set=x', /date --set/]]);
});

test('expandFlags splits clusters and keeps numeric flags and long options', () => {
  assert.deepEqual(expandFlags(['-la', '--color=auto', '-n5', '-20', '-i.bak']), ['-l', '-a', '--color', '-n', '-20', '-i']);
});

test('very long commands are not free', () => {
  assert.match(checkFree('ls ' + 'a'.repeat(2000)).reason ?? '', /too long/);
});
