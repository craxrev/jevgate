import re
from collections import Counter, defaultdict
import analyze as A  # reuse file discovery, split_compound, heredoc stripping, get_exec

FREE_SIMPLE = set("""cal uptime cat head tail wc stat strings hexdump od nl id uname free df du locale
groups nproc basename dirname realpath cut paste tr column tac rev fold expand unexpand fmt comm cmp
numfmt readlink diff true false sleep which type expr seq tsort pr echo ls file tree date hostname man
help netstat ps base64 lsof pgrep tput ss fd fdfind pyright test sha256sum sha1sum md5sum""".split())

WRAPPERS = {'sh','bash','env','time','timeout','nohup','sudo'}
ENV_WHITELIST = set("""GOEXPERIMENT GOOS GOARCH CGO_ENABLED GO111MODULE RUST_BACKTRACE RUST_LOG NODE_ENV
PYTHONUNBUFFERED PYTHONDONTWRITEBYTECODE PYTEST_DISABLE_PLUGIN_AUTOLOAD PYTEST_DEBUG LANG LANGUAGE LC_ALL
LC_CTYPE LC_TIME CHARSET TERM COLORTERM NO_COLOR FORCE_COLOR TZ LS_COLORS LSCOLORS GREP_COLOR GREP_COLORS
GCC_COLORS TIME_STYLE BLOCK_SIZE BLOCKSIZE COLUMNS LINES CLICOLOR CLICOLOR_FORCE CI DEBIAN_FRONTEND
GIT_TERMINAL_PROMPT""".split())

GIT_FREE_SUBS = {'diff','log','show','shortlog','reflog','ls-remote','status','blame','ls-files',
                  'merge-base','rev-parse','rev-list','describe','cat-file','for-each-ref','grep',
                  'tag','branch'}
GIT_FREE_TWO_WORD = {('stash','list'),('stash','show'),('config','--get'),('remote','show'),('worktree','list')}

INSTALL_PATTERNS = A.INSTALL_PATTERNS
DEV_TASK_PATTERNS = A.DEV_TASK_PATTERNS
DENY_PATTERNS = A.DENY_PATTERNS
GIT_WRITE_SUBS = A.GIT_WRITE_SUBS
FILE_WRITE_EXEC = A.FILE_WRITE_EXEC
NETWORK_DANGEROUS_EXEC = A.NETWORK_DANGEROUS_EXEC - WRAPPERS - {'eval','source'} | {'eval','source'}

def has_syntax_blocker(raw_cmd):
    reasons = []
    # command substitution / backticks / ${..}
    if '$(' in raw_cmd or '`' in raw_cmd or re.search(r'\$\{[^}]+\}', raw_cmd):
        reasons.append('subst')
    # unquoted $VAR (crude: not immediately preceded by an odd number of single quotes up to that point)
    for m in re.finditer(r'\$[A-Za-z_][A-Za-z0-9_]*', raw_cmd):
        before = raw_cmd[:m.start()]
        if before.count("'") % 2 == 0:  # not inside single quotes
            reasons.append('unquoted_var')
            break
    # subshell grouping "(" not part of $( and not inside quotes (crude)
    tmp = raw_cmd.replace('$(', '').replace(')', ')')
    for m in re.finditer(r'(?<!\$)\(', raw_cmd):
        before = raw_cmd[:m.start()]
        if before.count("'") % 2 == 0 and before.count('"') % 2 == 0:
            reasons.append('subshell')
            break
    # trailing background &
    if re.search(r'(?<!&)&\s*$', raw_cmd.strip()) and not raw_cmd.strip().endswith('&&'):
        reasons.append('background')
    # brace expansion
    if re.search(r'\{[^{}]*,[^{}]*\}', raw_cmd) or re.search(r'\{\d+\.\.\d+\}', raw_cmd):
        reasons.append('brace_expansion')
    # heredoc unquoted delimiter
    for m in re.finditer(r'<<-?\s*(\S+)', raw_cmd):
        delim = m.group(1)
        if not (delim.startswith("'") or delim.startswith('"')):
            reasons.append('heredoc_unquoted')
            break
    # redirects other than 2>&1 />/dev/null /2>/dev/null / <
    tmp2 = raw_cmd.replace('2>&1', '').replace('>/dev/null', '').replace('2>/dev/null', '')
    tmp2 = re.sub(r'(?<![<>])<(?!<)', '', tmp2)  # remove simple input redirects
    if re.search(r'>>?|<<(?!<)', tmp2.replace('<<','__HD__')):
        # after stripping known-ok patterns, any remaining > or non-heredoc << is a real redirect
        if re.search(r'>', tmp2) or ('__HD__' not in tmp2.replace('<<','__HD__') and False):
            reasons.append('redirect')
    return reasons

def has_wrapper_or_env(seg):
    seg = seg.strip()
    m = re.match(r'^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+)', seg)
    if m:
        assigns = re.findall(r'([A-Za-z_][A-Za-z0-9_]*)=', m.group(1))
        for a in assigns:
            if a not in ENV_WHITELIST:
                return True
        rest = seg[m.end():]
    else:
        rest = seg
    exe = A.get_exec(rest)
    if exe in WRAPPERS:
        return True
    return False

def free_check_segment(seg):
    """Return True if this segment's *content* is within the free set (ignoring syntax rules)."""
    seg = seg.strip()
    if not seg:
        return True
    exe = A.get_exec(seg)
    tokens = seg.split()

    if exe in FREE_SIMPLE:
        return True
    if exe in ('pwd','whoami','alias'):
        return len(tokens) == 1
    if exe == 'cd':
        return len(tokens) <= 2
    if exe == 'find':
        return not re.search(r'-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint\w*|-fls\b', seg)
    if exe == 'sed':
        return not re.search(r'(^|\s)-i\b|--in-place|\s-f\s|\s-f[^ ]', seg)
    if exe == 'sort':
        return not re.search(r'-o\b|--output\b', seg)
    if exe in ('grep','egrep','fgrep','rg'):
        return True
    if exe == 'xargs':
        m = re.search(r'xargs\b.*?(?:-\S+\s+)*(\S+)\s*$', seg)
        # crude: check final command token in xargs pipeline
        parts = seg.split()
        tail_cmds = {'echo','printf','wc','grep','head','tail'}
        return any(t in tail_cmds for t in parts[1:])
    if exe == 'docker':
        return len(tokens) > 1 and tokens[1] in ('ps','images','logs','inspect')
    if exe == 'gh':
        return len(tokens) > 1 and tokens[1] in ('view','list','status','pr','issue','repo') and \
               not re.search(r'\b(create|edit|close|merge|comment|delete)\b', seg)
    if exe == 'git':
        m = re.match(r'^git\s+(-c\s+\S+\s+|--exec-path=\S+\s+)', seg)
        if m:
            return False
        gm = re.match(r'^git\s+([a-zA-Z-]+)(?:\s+([a-zA-Z-]+))?', seg)
        if not gm:
            return False
        sub, sub2 = gm.group(1), gm.group(2)
        if sub == 'branch' and sub2 in ('-d','-D','-m'):
            return False
        if (sub, sub2) in GIT_FREE_TWO_WORD:
            return True
        if sub in GIT_FREE_SUBS:
            return True
        return False
    return False

def content_bucket_segment(seg):
    """Old-style content classification (ignores syntax-only issues)."""
    seg_s = seg.strip()
    if not seg_s:
        return 'FREE'
    lower = seg_s
    exe = A.get_exec(seg_s)

    for pat in DENY_PATTERNS:
        if pat.search(lower):
            return 'DENY_RULE'

    git_m = re.match(r'^git\s+([a-zA-Z-]+)', lower)
    git_sub = git_m.group(1) if git_m else None

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
    if exe in (NETWORK_DANGEROUS_EXEC - {'sh','bash','env','time','timeout','nohup'}):
        return 'NETWORK_OR_DANGEROUS'
    if exe == 'gh' and not free_check_segment(seg_s):
        return 'NETWORK_OR_DANGEROUS'

    for pat in INSTALL_PATTERNS:
        if pat.search(lower):
            return 'INSTALL'

    if exe == 'git' and git_sub in GIT_WRITE_SUBS:
        return 'GIT_WRITE'
    if exe == 'git' and git_sub == 'branch' and re.search(r'-[dD]\b|-m\b', lower):
        return 'GIT_WRITE'

    if exe in FILE_WRITE_EXEC:
        return 'FILE_WRITE'
    if exe == 'sed' and re.search(r'(^|\s)-i\b|--in-place', lower):
        return 'FILE_WRITE'
    tmp = lower.replace('2>&1', '')
    tmp = re.sub(r'>\s*/dev/null', '', tmp)
    tmp = re.sub(r'2>\s*/dev/null', '', tmp)
    if re.search(r'(?<!\d)>>?(?!&)', tmp):
        return 'FILE_WRITE'

    for pat, _ in DEV_TASK_PATTERNS:
        if pat.search(lower):
            return 'DEV_TASK'

    if free_check_segment(seg_s):
        return 'FREE'
    return 'SCRIPT_OR_UNKNOWN'

PRIORITY2 = ['DENY_RULE','NETWORK_OR_DANGEROUS','INSTALL','GIT_WRITE','FILE_WRITE','SCRIPT_OR_UNKNOWN','DEV_TASK','SHELL_SYNTAX','FREE']

INLINE_SCRIPT_RE = re.compile(r'(<<-?\s*[\'"]?\w+[\'"]?)|(-c\b)|(-e\b\s*[\'"])|(python3?\s+-c)|(node\s+-e)')

def classify_command2(raw_cmd):
    cmd_stripped = A.strip_heredoc_bodies(raw_cmd)
    segs = A.split_compound(raw_cmd)  # split_compound already strips heredocs internally
    if not segs:
        return 'FREE', [], False, False

    cds = sum(1 for s in segs if A.get_exec(s) == 'cd')
    has_git = any(A.get_exec(s) == 'git' for s in segs)
    multi_cd_violation = cds > 1 or (cds >= 1 and has_git and len(segs) > 1 and cds >=1 and has_git)
    # per spec: "a compound with more than one cd, OR cd combined with git" -> not free
    cd_git_violation = (cds > 1) or (cds >= 1 and has_git)

    content_buckets = [content_bucket_segment(s) for s in segs]
    worst_content = min(content_buckets, key=lambda b: PRIORITY2.index(b)) if content_buckets else 'FREE'

    syntax_reasons = has_syntax_blocker(raw_cmd)
    wrapper_env_hit = any(has_wrapper_or_env(s) for s in segs)
    syntax_blocked = bool(syntax_reasons) or wrapper_env_hit or cd_git_violation

    if worst_content != 'FREE':
        final = worst_content
    elif syntax_blocked:
        final = 'SHELL_SYNTAX'
    else:
        final = 'FREE'

    compound = len(segs) > 1
    inline_script = bool(INLINE_SCRIPT_RE.search(raw_cmd))
    return final, content_buckets, compound, inline_script

def analyze_file2(filepath):
    calls, parse_failures = A.iter_bash_calls(filepath)
    bucket_counts = Counter()
    compound_total = 0
    compound_single_blocker = 0
    single_blocker_bucket_counter = Counter()
    script_unknown_exec_counter = Counter()
    inline_script_in_bucket = Counter()  # bucket -> count where inline_script True
    for cmd in calls:
        final, seg_buckets, compound, inline_script = classify_command2(cmd)
        bucket_counts[final] += 1
        if inline_script:
            inline_script_in_bucket[final] += 1
        if final == 'SCRIPT_OR_UNKNOWN':
            segs = A.split_compound(cmd)
            SHELL_KEYWORDS = {'for','do','done','if','then','else','elif','fi','while','case','esac','in','until'}
            for s in segs:
                if content_bucket_segment(s) == 'SCRIPT_OR_UNKNOWN':
                    e = A.get_exec(s)
                    if e and e not in SHELL_KEYWORDS and not e.isdigit():
                        script_unknown_exec_counter[e] += 1
        if compound:
            compound_total += 1
            non_free = [b for b in seg_buckets if b != 'FREE']
            if len(non_free) == 1 and final != 'FREE' and final != 'SHELL_SYNTAX':
                compound_single_blocker += 1
                single_blocker_bucket_counter[non_free[0]] += 1
    return {'total': len(calls), 'bucket_counts': bucket_counts, 'compound_total': compound_total,
            'compound_single_blocker': compound_single_blocker,
            'single_blocker_bucket_counter': single_blocker_bucket_counter,
            'script_unknown_exec_counter': script_unknown_exec_counter,
            'inline_script_in_bucket': inline_script_in_bucket,
            'parse_failures': parse_failures}

def main():
    transcripts = A.find_all_transcripts()
    agg = {'total':0,'bucket_counts':Counter(),'compound_total':0,'compound_single_blocker':0,
           'single_blocker_bucket_counter':Counter(),'script_unknown_exec_counter':Counter(),
           'inline_script_in_bucket':Counter(),'parse_failures':0}
    for proj, sid, path in transcripts:
        r = analyze_file2(path)
        agg['total'] += r['total']
        agg['bucket_counts'].update(r['bucket_counts'])
        agg['compound_total'] += r['compound_total']
        agg['compound_single_blocker'] += r['compound_single_blocker']
        agg['single_blocker_bucket_counter'].update(r['single_blocker_bucket_counter'])
        agg['script_unknown_exec_counter'].update(r['script_unknown_exec_counter'])
        agg['inline_script_in_bucket'].update(r['inline_script_in_bucket'])
        agg['parse_failures'] += r['parse_failures']

    tot = agg['total']
    print(f"Total Bash calls: {tot}  (sessions: {len(transcripts)})")
    for b in PRIORITY2:
        c = agg['bucket_counts'].get(b,0)
        print(f"  {b}: {c} ({100*c/tot:.1f}%)")
    print(f"parse_failures: {agg['parse_failures']}")

    reaches = tot - agg['bucket_counts'].get('FREE',0) - agg['bucket_counts'].get('DENY_RULE',0)
    print(f"\nReaches classifier today: {reaches} ({100*reaches/tot:.1f}% of all)")
    shell_syn = agg['bucket_counts'].get('SHELL_SYNTAX',0)
    print(f"SHELL_SYNTAX: {shell_syn} ({100*shell_syn/tot:.1f}% of all, {100*shell_syn/reaches:.1f}% of reaches-classifier)")

    dev = agg['bucket_counts'].get('DEV_TASK',0)
    fw = agg['bucket_counts'].get('FILE_WRITE',0)
    gw = agg['bucket_counts'].get('GIT_WRITE',0)
    inst = agg['bucket_counts'].get('INSTALL',0)
    scr = agg['bucket_counts'].get('SCRIPT_OR_UNKNOWN',0)
    inline_scr = agg['inline_script_in_bucket'].get('SCRIPT_OR_UNKNOWN',0)

    print("\nFast-lane tiers:")
    t_syn = shell_syn
    t_syn_fw = shell_syn+fw
    t_syn_fw_gw = shell_syn+fw+gw
    t_syn_fw_gw_inst = shell_syn+fw+gw+inst
    t_all_plus_inline = t_syn_fw_gw_inst + inline_scr
    for name,val in [('SHELL_SYNTAX only',t_syn), ('+FILE_WRITE',t_syn_fw),
                      ('+GIT_WRITE',t_syn_fw_gw), ('+INSTALL',t_syn_fw_gw_inst),
                      ('+inline-script SCRIPT_OR_UNKNOWN (heredoc/-c/-e)',t_all_plus_inline)]:
        print(f"  {name}: {val} -> {100*val/tot:.1f}% all, {100*val/reaches:.1f}% reaches-classifier")

    print(f"\n(DEV_TASK={dev} already free-ish per old rules but no longer separately tiered here)")
    print("\nTop 15 remaining SCRIPT_OR_UNKNOWN executables:")
    for e,c in agg['script_unknown_exec_counter'].most_common(15):
        print(f"  {e}: {c}")

    print("\nCompound stats:")
    cpct = 100*agg['compound_total']/tot
    print(f"  compound calls: {agg['compound_total']} ({cpct:.1f}% of all)")
    if agg['compound_total']:
        sb = agg['compound_single_blocker']
        print(f"  single-blocker compounds: {sb} ({100*sb/agg['compound_total']:.1f}% of compound)")
    print("  single-blocker bucket dist:")
    for b,c in agg['single_blocker_bucket_counter'].most_common():
        print(f"    {b}: {c}")

if __name__ == '__main__':
    main()
