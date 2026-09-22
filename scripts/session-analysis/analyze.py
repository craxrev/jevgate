import json, os, re, sys
from collections import defaultdict, Counter

ROOT = os.path.expanduser(os.environ.get("JEVGATE_TRANSCRIPTS", "~/.claude/projects"))
# Transcript directories or session ids to skip (comma-separated), e.g. the session doing the analysis.
EXCLUDE_PROJECTS = set(filter(None, os.environ.get("JEVGATE_EXCLUDE_PROJECTS", "").split(",")))
EXCLUDE_SESSIONS = set(filter(None, os.environ.get("JEVGATE_EXCLUDE_SESSIONS", "").split(",")))
# Sessions to report on individually, as "project-dir:session-id", comma-separated. Empty: aggregate only.
SELECTED = [tuple(x.split(":", 1)) for x in filter(None, os.environ.get("JEVGATE_SELECTED", "").split(","))]

FREE_EXEC = set("""ls cat echo pwd head tail grep find wc which diff stat du cd
sort uniq cut tr basename dirname realpath readlink file tree date whoami uname true test env printenv""".split())

DEV_TASK_PATTERNS = [
    (re.compile(r'^npm\s+test\b'), True),
    (re.compile(r'^npm\s+run\s+(?!deploy|publish|release)\S+'), True),
    (re.compile(r'^(yarn|pnpm|bun)\s+(test)\b'), True),
    (re.compile(r'^(yarn|pnpm|bun)\s+run\s+(?!deploy|publish|release)\S+'), True),
    (re.compile(r'^node\s+--test\b'), True),
    (re.compile(r'^pytest\b'), True),
    (re.compile(r'^jest\b'), True),
    (re.compile(r'^vitest\b'), True),
    (re.compile(r'^go\s+(test|vet|build)\b'), True),
    (re.compile(r'^cargo\s+(test|check|build|clippy)\b'), True),
    (re.compile(r'^tsc\b'), True),
    (re.compile(r'^eslint\b'), True),
    (re.compile(r'^prettier\s+.*--check'), True),
    (re.compile(r'^ruff\b'), True),
    (re.compile(r'^mypy\b'), True),
    (re.compile(r'^make\s+(test|build|lint)\b'), True),
    (re.compile(r'^(gradle|gradlew|mvn|mvnw)\s+.*test\b'), True),
    (re.compile(r'^dotnet\s+(test|build)\b'), True),
    (re.compile(r'^php\s+artisan\s+test\b'), True),
    (re.compile(r'^composer\s+test\b'), True),
    (re.compile(r'^phpunit\b'), True),
    (re.compile(r'^rspec\b'), True),
    (re.compile(r'^mix\s+test\b'), True),
]

GIT_WRITE_SUBS = set("add commit checkout switch stash tag merge rebase cherry-pick restore reset".split())

DENY_PATTERNS = [
    re.compile(r'^git\s+push\b'),
    re.compile(r'^git\s+reset\s+--hard\b'),
    re.compile(r'^git\s+clean\s+.*-f'),
    re.compile(r'^git\s+checkout\s+--\s'),
    re.compile(r'^git\s+branch\s+.*-D\b'),
    re.compile(r'^rm\s+-rf\s+\*'),
]

NETWORK_DANGEROUS_EXEC = set("curl wget ssh scp rsync sudo docker kubectl aws gcloud az terraform gh kill eval source".split())

INSTALL_PATTERNS = [
    re.compile(r'^(npm|yarn|pnpm|bun)\s+(install|add|ci)\b'),
    re.compile(r'^npx\b'),
    re.compile(r'^(pip|pip3|uv|poetry)\s+install\b'),
    re.compile(r'^brew\s+(install|upgrade)\b'),
    re.compile(r'^apt(-get)?\s+install\b'),
    re.compile(r'^cargo\s+add\b'),
    re.compile(r'^composer\s+(install|require)\b'),
    re.compile(r'^gem\s+install\b'),
]

FILE_WRITE_EXEC = set("mkdir cp mv rm touch ln chmod tee truncate".split())

HEREDOC_START = re.compile(r'<<-?\s*[\'"]?(\w+)[\'"]?')

def strip_heredoc_bodies(cmd):
    # replace heredoc body lines with nothing so newline-splitting doesn't treat
    # script content as separate shell segments/executables (best-effort).
    lines = cmd.split('\n')
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = HEREDOC_START.search(line)
        if m:
            term = m.group(1)
            i += 1
            while i < len(lines) and lines[i].strip() != term:
                i += 1
            # skip the terminator line itself too (already consumed as body end)
            if i < len(lines):
                i += 1
            continue
        i += 1
    return '\n'.join(out)

def split_compound(cmd):
    # split on &&, ||, ;, |, |&, & and newlines, respecting quotes (best-effort)
    cmd = strip_heredoc_bodies(cmd)
    parts = []
    buf = []
    i = 0
    n = len(cmd)
    quote = None
    while i < n:
        c = cmd[i]
        if quote:
            buf.append(c)
            if c == quote and (i == 0 or cmd[i-1] != '\\'):
                quote = None
            i += 1
            continue
        if c in ('"', "'"):
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == '\n':
            parts.append(''.join(buf)); buf=[]
            i += 1
            continue
        if c == '&' and i+1 < n and cmd[i+1] == '&':
            parts.append(''.join(buf)); buf=[]
            i += 2
            continue
        if c == '|' and i+1 < n and cmd[i+1] == '|':
            parts.append(''.join(buf)); buf=[]
            i += 2
            continue
        if c == '|' and i+1 < n and cmd[i+1] == '&':
            parts.append(''.join(buf)); buf=[]
            i += 2
            continue
        if c == '|':
            parts.append(''.join(buf)); buf=[]
            i += 1
            continue
        if c == ';':
            parts.append(''.join(buf)); buf=[]
            i += 1
            continue
        if c == '&':
            parts.append(''.join(buf)); buf=[]
            i += 1
            continue
        buf.append(c)
        i += 1
    parts.append(''.join(buf))
    return [p.strip() for p in parts if p.strip()]

def get_exec(seg):
    seg = seg.strip()
    # strip leading env assignments like FOO=bar
    seg = re.sub(r'^\s*(\w+=\S+\s+)+', '', seg)
    m = re.match(r'^([^\s]+)', seg)
    if not m:
        return ''
    tok = m.group(1)
    tok = tok.split('/')[-1]
    return tok

def has_real_redirect(seg):
    # remove 2>&1 and >/dev/null occurrences then look for > >>
    tmp = seg.replace('2>&1', '')
    tmp = re.sub(r'>\s*/dev/null', '', tmp)
    return bool(re.search(r'(?<!\d)>>?(?!&)', tmp))

def classify_segment(seg):
    seg_stripped = seg.strip()
    if not seg_stripped:
        return 'FREE'
    lower = seg_stripped
    exe = get_exec(seg_stripped)

    for pat in DENY_PATTERNS:
        if pat.search(lower):
            return 'DENY_RULE'

    # git subcommand extraction
    git_m = re.match(r'^git\s+([a-zA-Z-]+)', lower)
    git_sub = git_m.group(1) if git_m else None

    # NETWORK_OR_DANGEROUS checks
    if exe in NETWORK_DANGEROUS_EXEC:
        return 'NETWORK_OR_DANGEROUS'
    if exe == 'git' and git_sub == 'push':
        return 'NETWORK_OR_DANGEROUS'
    if exe == 'git' and git_sub == 'reset' and '--hard' in lower:
        return 'NETWORK_OR_DANGEROUS'
    if exe == 'git' and git_sub == 'clean':
        return 'NETWORK_OR_DANGEROUS'
    if exe == 'git' and git_sub == 'remote' and re.search(r'\b(add|set-url)\b', lower):
        return 'NETWORK_OR_DANGEROUS'
    if exe == 'rm' and '-rf' in lower and ('..' in lower or re.search(r'-rf\s+/', lower)):
        return 'NETWORK_OR_DANGEROUS'
    if re.search(r'\|\s*(sh|bash|python3?|node)\b', lower):
        return 'NETWORK_OR_DANGEROUS'

    # INSTALL
    for pat in INSTALL_PATTERNS:
        if pat.search(lower):
            return 'INSTALL'

    # GIT_WRITE
    if exe == 'git' and git_sub in GIT_WRITE_SUBS:
        if git_sub == 'reset' and '--hard' in lower:
            pass  # already caught above as NETWORK/DANGEROUS
        return 'GIT_WRITE'
    if exe == 'git' and git_sub == 'branch' and re.search(r'-[dD]\b', lower):
        return 'GIT_WRITE'

    # FILE_WRITE
    if exe in FILE_WRITE_EXEC:
        return 'FILE_WRITE'
    if exe == 'sed' and '-i' in lower.split():
        return 'FILE_WRITE'
    if re.search(r'-i\b', lower) and exe == 'sed':
        return 'FILE_WRITE'
    if has_real_redirect(lower):
        return 'FILE_WRITE'
    if re.search(r'<<-?\s*[\'"]?\w+', lower) and has_real_redirect(lower):
        return 'FILE_WRITE'

    # DEV_TASK
    for pat, _ in DEV_TASK_PATTERNS:
        if pat.search(lower):
            return 'DEV_TASK'

    # FREE
    read_only_git = {'status','log','diff','show','blame','ls-files','rev-parse','describe','shortlog'}
    if exe == 'git':
        if git_sub in read_only_git:
            return 'FREE'
        if git_sub == 'branch' and not re.search(r'-[dDm]\b', lower):
            return 'FREE'
        if git_sub == 'remote' and re.search(r'(-v|show)\b', lower):
            return 'FREE'
        if git_sub == 'stash' and 'list' in lower:
            return 'FREE'
        # unknown git subcommand -> treat conservatively as SCRIPT_OR_UNKNOWN
        return 'SCRIPT_OR_UNKNOWN'

    if exe == 'find' and ('-delete' in lower or '-exec' in lower):
        return 'SCRIPT_OR_UNKNOWN'

    if exe == 'awk':
        # awk without file output - crude check for > outside handled already
        return 'FREE'

    if exe in FREE_EXEC:
        return 'FREE'

    return 'SCRIPT_OR_UNKNOWN'

PRIORITY = ['DENY_RULE','NETWORK_OR_DANGEROUS','INSTALL','GIT_WRITE','FILE_WRITE','SCRIPT_OR_UNKNOWN','DEV_TASK','FREE']

def classify_command(cmd):
    segs = split_compound(cmd)
    if not segs:
        return 'FREE', [], False
    buckets = [classify_segment(s) for s in segs]
    worst = min(buckets, key=lambda b: PRIORITY.index(b))
    compound = len(segs) > 1
    return worst, buckets, compound

def iter_bash_calls(filepath):
    parse_failures = 0
    calls = []
    with open(filepath, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                parse_failures += 1
                continue
            if obj.get('type') != 'assistant':
                continue
            if obj.get('isSidechain'):
                continue
            msg = obj.get('message', {})
            content = msg.get('content')
            if not isinstance(content, list):
                continue
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Bash':
                    inp = block.get('input', {})
                    cmd = inp.get('command', '')
                    calls.append(cmd)
    return calls, parse_failures

def find_all_transcripts():
    out = []
    for proj in os.listdir(ROOT):
        if proj in EXCLUDE_PROJECTS:
            continue
        proj_path = os.path.join(ROOT, proj)
        if not os.path.isdir(proj_path):
            continue
        for fn in os.listdir(proj_path):
            if not fn.endswith('.jsonl'):
                continue
            sid = fn[:-6]
            if sid in EXCLUDE_SESSIONS:
                continue
            out.append((proj, sid, os.path.join(proj_path, fn)))
    return out

def analyze_file(filepath):
    calls, parse_failures = iter_bash_calls(filepath)
    bucket_counts = Counter()
    compound_total = 0
    compound_single_blocker = 0
    single_blocker_bucket_counter = Counter()
    script_unknown_exec_counter = Counter()
    examples = defaultdict(list)
    for cmd in calls:
        worst, seg_buckets, compound = classify_command(cmd)
        bucket_counts[worst] += 1
        if worst not in ('FREE',):
            examples[worst].append(cmd[:100])
        if worst == 'SCRIPT_OR_UNKNOWN':
            # count exec of the segment(s) that caused SCRIPT_OR_UNKNOWN
            SHELL_KEYWORDS = {'for','do','done','if','then','else','elif','fi','while',
                               'case','esac','in','until','function','select','time'}
            segs = split_compound(cmd)
            for s in segs:
                if classify_segment(s) == 'SCRIPT_OR_UNKNOWN':
                    e = get_exec(s)
                    if e and e not in SHELL_KEYWORDS and not e.isdigit():
                        script_unknown_exec_counter[e] += 1
        if compound:
            compound_total += 1
            non_free_buckets = [b for b in seg_buckets if b != 'FREE']
            if len(non_free_buckets) == 1 and len(seg_buckets) > 1 and worst != 'FREE':
                compound_single_blocker += 1
                single_blocker_bucket_counter[non_free_buckets[0]] += 1
    return {
        'total': len(calls),
        'bucket_counts': bucket_counts,
        'compound_total': compound_total,
        'compound_single_blocker': compound_single_blocker,
        'single_blocker_bucket_counter': single_blocker_bucket_counter,
        'script_unknown_exec_counter': script_unknown_exec_counter,
        'parse_failures': parse_failures,
        'examples': examples,
    }

def merge(agg, res):
    agg['total'] += res['total']
    agg['bucket_counts'].update(res['bucket_counts'])
    agg['compound_total'] += res['compound_total']
    agg['compound_single_blocker'] += res['compound_single_blocker']
    agg['single_blocker_bucket_counter'].update(res['single_blocker_bucket_counter'])
    agg['script_unknown_exec_counter'].update(res['script_unknown_exec_counter'])
    agg['parse_failures'] += res['parse_failures']
    for k, v in res['examples'].items():
        agg['examples'][k].extend(v)

def new_agg():
    return {'total':0,'bucket_counts':Counter(),'compound_total':0,'compound_single_blocker':0,
            'single_blocker_bucket_counter':Counter(),'script_unknown_exec_counter':Counter(),
            'parse_failures':0,'examples':defaultdict(list)}

def main():
    all_transcripts = find_all_transcripts()
    print(f"# Remaining transcripts found: {len(all_transcripts)}")

    total_agg = new_agg()
    per_selected = []

    selected_paths = {}
    for proj, sid, path in all_transcripts:
        if (proj, sid) in SELECTED:
            selected_paths[(proj,sid)] = path

    for proj, sid, path in all_transcripts:
        res = analyze_file(path)
        merge(total_agg, res)
        if (proj, sid) in SELECTED:
            per_selected.append((proj, sid, res))

    print("\n=== PER SELECTED SESSION ===")
    for proj, sid, res in per_selected:
        print(f"\n-- {proj} / {sid[:8]} --")
        print(f"Total Bash calls: {res['total']}")
        for b in PRIORITY:
            c = res['bucket_counts'].get(b,0)
            pct = 100*c/res['total'] if res['total'] else 0
            print(f"  {b}: {c} ({pct:.1f}%)")
        print(f"parse_failures: {res['parse_failures']}")

    print("\n=== TOTALS ACROSS ALL REMAINING SESSIONS ===")
    print(f"Total Bash calls: {total_agg['total']}")
    for b in PRIORITY:
        c = total_agg['bucket_counts'].get(b,0)
        pct = 100*c/total_agg['total'] if total_agg['total'] else 0
        print(f"  {b}: {c} ({pct:.1f}%)")
    print(f"Total parse_failures: {total_agg['parse_failures']}")

    reaches = total_agg['total'] - total_agg['bucket_counts'].get('FREE',0) - total_agg['bucket_counts'].get('DENY_RULE',0)
    print(f"\nReaches classifier today: {reaches} ({100*reaches/total_agg['total']:.1f}% of all)")

    dev = total_agg['bucket_counts'].get('DEV_TASK',0)
    fw = total_agg['bucket_counts'].get('FILE_WRITE',0)
    gw = total_agg['bucket_counts'].get('GIT_WRITE',0)
    inst = total_agg['bucket_counts'].get('INSTALL',0)
    net = total_agg['bucket_counts'].get('NETWORK_OR_DANGEROUS',0)
    scr = total_agg['bucket_counts'].get('SCRIPT_OR_UNKNOWN',0)

    tot = total_agg['total']
    print("\n=== FAST-LANE POTENTIAL ===")
    t1 = dev
    t12 = dev+fw
    t123 = dev+fw+gw
    t1234 = dev+fw+gw+inst
    never = net+scr
    for name, val in [('Tier1 (DEV_TASK)', t1), ('Tier1+2 (+FILE_WRITE)', t12),
                       ('Tier1+2+3 (+GIT_WRITE)', t123), ('Tier1+2+3+4 (+INSTALL)', t1234),
                       ('Never fast-laned (NET+SCRIPT)', never)]:
        pct_all = 100*val/tot if tot else 0
        pct_reach = 100*val/reaches if reaches else 0
        print(f"  {name}: {val} -> {pct_all:.1f}% of all, {pct_reach:.1f}% of reaches-classifier")

    print("\nTop 15 SCRIPT_OR_UNKNOWN executables:")
    for exe, c in total_agg['script_unknown_exec_counter'].most_common(15):
        print(f"  {exe}: {c}")

    print("\n=== COMPOUND STATS ===")
    compound_pct = 100*total_agg['compound_total']/tot if tot else 0
    print(f"Compound calls: {total_agg['compound_total']} ({compound_pct:.1f}% of all)")
    if total_agg['compound_total']:
        sb_pct = 100*total_agg['compound_single_blocker']/total_agg['compound_total']
        print(f"Single-blocker compounds: {total_agg['compound_single_blocker']} ({sb_pct:.1f}% of compound)")
    print("Single-blocker bucket distribution:")
    for b, c in total_agg['single_blocker_bucket_counter'].most_common():
        print(f"  {b}: {c}")

    print("\n=== 20 EXAMPLE COMMANDS (reaches classifier) ===")
    picked = []
    for b in ['NETWORK_OR_DANGEROUS','INSTALL','GIT_WRITE','FILE_WRITE','SCRIPT_OR_UNKNOWN','DEV_TASK']:
        exs = total_agg['examples'].get(b, [])
        for e in exs[:4]:
            picked.append((b,e))
    for b,e in picked[:20]:
        print(f"  [{b}] {e}")

if __name__ == '__main__':
    main()
