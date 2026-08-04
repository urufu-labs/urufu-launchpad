#!/usr/bin/env bash
# Runs the static-analysis pass we track pre-broadcast. Requires:
#   pip install slither-analyzer
#
# Usage:
#   ./security.sh                   # summary only
#   ./security.sh --full            # full detector output
#
# Outputs:
#   slither-report.json  — machine-readable full report
#   slither-summary.md    — human summary of severity counts + top checks
set -euo pipefail
cd "$(dirname "$0")"

FULL="${1:-}"

# URU-A14: scan src/ + script/. Previously excluded script/ via
# filter_paths, so deploy + handoff scripts (where several audit blockers
# live) evaded the security gate entirely.
echo ">>> Running Slither on . (src + script) (this can take a couple minutes on cold caches)"
if [[ "$FULL" == "--full" ]]; then
  python -m slither . --config-file slither.config.json
else
  # URU-A14: removed `|| true` — a Slither failure must fail this script,
  # not print a fake "0 findings" summary and let CI pass.
  python -m slither . --config-file slither.config.json --json slither-report.json
fi

# Emit a summary markdown alongside the JSON so it's easy to diff between runs.
python <<'PY'
import json, os

with open('slither-report.json') as f:
    data = json.load(f)

counts = {}
by_check = {}
for r in data.get('results', {}).get('detectors', []):
    counts[r['impact']] = counts.get(r['impact'], 0) + 1
    by_check[r['check']] = by_check.get(r['check'], 0) + 1

lines = ['# Slither summary', '']
lines.append('| Impact | Count |')
lines.append('|---|---|')
for k in ['High', 'Medium', 'Low', 'Informational']:
    lines.append(f'| {k} | {counts.get(k, 0)} |')

lines += ['', '## Top detectors', '', '| Detector | Count |', '|---|---|']
for k, v in sorted(by_check.items(), key=lambda x: -x[1])[:15]:
    lines.append(f'| `{k}` | {v} |')

with open('slither-summary.md', 'w') as f:
    f.write('\n'.join(lines) + '\n')

high = counts.get('High', 0)
print()
print('=' * 60)
print(f"Summary: {high} High, {counts.get('Medium', 0)} Medium, "
      f"{counts.get('Low', 0)} Low, {counts.get('Informational', 0)} Informational")
print('=' * 60)
print()
print(f"  full JSON:      slither-report.json")
print(f"  markdown:       slither-summary.md")
print(f"  triage notes:   .github/SECURITY.md")

# URU-A14 additional-defect close: fail the gate on ANY High finding. Medium
# and below are reported for triage but non-blocking; High blocks merge.
import sys
if high > 0:
    print()
    print(f"FAIL: {high} High-severity finding(s) present. Review + fix before merge.")
    sys.exit(1)
PY
