#!/usr/bin/env bash
# Publishes the tail and the error lines of a CI log to the "ci-logs" branch,
# so they can be read without access to the Actions UI.
# usage: push-log.sh <log file> <name>
set -u
LOG=${1:-build.log}
NAME=${2:-run}
[ -f "$LOG" ] || echo "no log" > "$LOG"
cp "$LOG" /tmp/ci.log
git config user.name "hey-meld-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git reset -q --hard
git clean -fdq
if git fetch -q --depth=1 origin ci-logs; then
  git checkout -q -B ci-logs FETCH_HEAD
else
  git checkout -q --orphan ci-logs
  git rm -rfq . || true
fi
mkdir -p logs
grep -nE "^e: |error:|FAILED|What went wrong|Exception|Error|Traceback|\.kt:[0-9]+" -A4 /tmp/ci.log | head -600 > "logs/$NAME-errors.txt" || true
tail -400 /tmp/ci.log > "logs/$NAME-tail.txt"
git add -f logs
git commit -qm "log $NAME"
git push -qf origin ci-logs
