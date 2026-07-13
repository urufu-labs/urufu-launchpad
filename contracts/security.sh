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

echo ">>> Running Slither on src/ (this can take a couple minutes on cold caches)"
if [[ "$FULL" == "--full" ]]; then
  python -m slither src --config-file slither.config.json
else
  python -m slither src --config-file slither.config.json --json slither-report.json 2>/dev/null || true
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

print()
print('=' * 60)
print(f"Summary: {counts.get('High', 0)} High, {counts.get('Medium', 0)} Medium, "
      f"{counts.get('Low', 0)} Low, {counts.get('Informational', 0)} Informational")
print('=' * 60)
print()
print(f"  full JSON:      slither-report.json")
print(f"  markdown:       slither-summary.md")
print(f"  triage notes:   .github/SECURITY.md")
PY
