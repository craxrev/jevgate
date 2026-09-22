"""Dump every Bash call in the local transcripts with its analyze2 bucket, as
JSON lines {"cmd": ..., "bucket": ...}. Feed the file to scripts/free-corpus.ts.

    python3 scripts/session-analysis/dump_buckets.py > /path/to/buckets.jsonl
"""
import json, sys
import analyze as A
import analyze2 as A2

def main():
    for proj, sid, path in A.find_all_transcripts():
        calls, _ = A.iter_bash_calls(path)
        for cmd in calls:
            final, _, _, _ = A2.classify_command2(cmd)
            sys.stdout.write(json.dumps({"cmd": cmd, "bucket": final}) + "\n")

if __name__ == '__main__':
    main()
