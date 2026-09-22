"""Dump every Bash call in the local transcripts as JSON lines for the probes:
{"cmd", "bucket" (analyze2), "project" (decoded transcript dir), "recent" (last
8 turns of both roles before the call, as {role, text}, truncated)}. Stays in the scratchpad: `recent`
is private conversation text.

    python3 scripts/session-analysis/dump_buckets.py > /path/to/buckets.jsonl
"""
import json, re, sys
import analyze as A
import analyze2 as A2

RECENT_N = 8
RECENT_MAX = 1500
META = re.compile(r'^<(system-reminder|local-command|command-name|bash-input|task-notification)')

def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')

def iter_calls_with_recent(path):
    recent = []
    with open(path, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get('isSidechain'):
                continue
            msg = obj.get('message', {})
            if obj.get('type') == 'user':
                t = text_of(msg.get('content')).strip()
                if t and not META.match(t):
                    recent.append({"role": "user", "text": t if len(t) <= RECENT_MAX else t[:RECENT_MAX] + ' […]'})
                    recent = recent[-RECENT_N:]
                continue
            if obj.get('type') != 'assistant':
                continue
            content = msg.get('content')
            if not isinstance(content, list):
                continue
            t = text_of(content).strip()
            if t:
                recent.append({"role": "assistant", "text": t if len(t) <= RECENT_MAX else t[:RECENT_MAX] + ' […]'})
                recent = recent[-RECENT_N:]
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Bash':
                    yield block.get('input', {}).get('command', ''), list(recent)

def main():
    for proj, sid, path in A.find_all_transcripts():
        project = '/' + proj.lstrip('-').replace('-', '/')
        for cmd, recent in iter_calls_with_recent(path):
            final, _, _, _ = A2.classify_command2(cmd)
            sys.stdout.write(json.dumps({"cmd": cmd, "bucket": final, "project": project, "recent": recent}) + "\n")

if __name__ == '__main__':
    main()
