#!/usr/bin/env bash
#
# lambda-smoke-test.sh — Invoke all CI agent Lambdas with test payloads.
#
# Usage:
#   ./scripts/lambda-smoke-test.sh              # Test all agents
#   ./scripts/lambda-smoke-test.sh linting       # Test specific agent(s)
#   ./scripts/lambda-smoke-test.sh --verbose     # Show full response bodies
#
set -euo pipefail

AWS_REGION="us-east-2"
ALL_AGENTS=(linting security speed unit-tests documentation api-contracts synthesis)

VERBOSE=false
SELECTED_AGENTS=()

for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=true ;;
    --help|-h)    head -9 "$0" | tail -7; exit 0 ;;
    *)
      if printf '%s\n' "${ALL_AGENTS[@]}" | grep -qx "$arg"; then
        SELECTED_AGENTS+=("$arg")
      else
        echo "ERROR: Unknown agent: $arg" >&2; exit 1
      fi
      ;;
  esac
done

if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
  SELECTED_AGENTS=("${ALL_AGENTS[@]}")
fi

# Standard agent payload
cat > /tmp/test-agent-payload.json << 'EOF'
{
  "pr_number": 0,
  "repo": "smoke-test",
  "files": {},
  "blast_radius": [],
  "previous_reports": []
}
EOF

# Synthesis payload
cat > /tmp/test-synthesis-payload.json << 'EOF'
{
  "pr_number": 0,
  "pr_title": "Smoke test PR",
  "pr_author": "smoke-test",
  "pr_url": "https://github.com/test/test/pull/0",
  "repository": "smoke-test/repo",
  "agent_reports": [],
  "blast_radius_stats": {
    "changed_count": 0,
    "total_scope": 0
  }
}
EOF

echo "Testing ${#SELECTED_AGENTS[@]} agent(s) in $AWS_REGION"
echo "─────────────────────────────────────────"

PASS=0
FAIL=0

for agent in "${SELECTED_AGENTS[@]}"; do
  echo -n "ci-agent-$agent ... "

  if [[ "$agent" == "synthesis" ]]; then
    PAYLOAD="/tmp/test-synthesis-payload.json"
  else
    PAYLOAD="/tmp/test-agent-payload.json"
  fi

  RESPONSE="/tmp/test-response-$agent.json"
  META="/tmp/test-meta-$agent.json"

  if aws lambda invoke \
    --function-name "ci-agent-$agent" \
    --region "$AWS_REGION" \
    --payload "fileb://$PAYLOAD" \
    --no-cli-pager \
    "$RESPONSE" > "$META" 2>&1; then

    if jq -e '.FunctionError' "$META" > /dev/null 2>&1; then
      echo "FAIL (function error)"
      ERROR_TYPE=$(jq -r '.errorType // "unknown"' "$RESPONSE" 2>/dev/null)
      ERROR_MSG=$(jq -r '.errorMessage // "unknown"' "$RESPONSE" 2>/dev/null)
      echo "  Error: $ERROR_TYPE — $ERROR_MSG"
      FAIL=$((FAIL + 1))
    else
      echo "PASS"
      if [[ "$VERBOSE" == "true" ]]; then
        jq '.' "$RESPONSE" 2>/dev/null || cat "$RESPONSE"
      fi
      PASS=$((PASS + 1))
    fi
  else
    echo "FAIL (invocation error)"
    cat "$META"
    FAIL=$((FAIL + 1))
  fi
done

echo "─────────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed (of ${#SELECTED_AGENTS[@]})"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
