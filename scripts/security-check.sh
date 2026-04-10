#!/usr/bin/env bash
#
# Pre-deploy security check — run this before deploying to catch known
# vulnerabilities in Python and Node.js dependencies.
#
# Usage: ./scripts/security-check.sh
#
# Exit codes:
#   0 = all checks passed
#   1 = vulnerabilities found or a tool is missing

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILED=0

echo "========================================="
echo "  Security Check — MEDIA COMMAND CENTER"
echo "========================================="
echo ""

# ── Python dependency audit ──────────────────────────────────────────
echo -e "${YELLOW}[1/2] Python dependencies (pip-audit)${NC}"
if command -v pip-audit &> /dev/null; then
    if pip-audit 2>&1; then
        echo -e "${GREEN}  ✓ No known Python vulnerabilities${NC}"
    else
        echo -e "${RED}  ✗ Python vulnerabilities found — see above${NC}"
        FAILED=1
    fi
else
    echo -e "${YELLOW}  ⚠ pip-audit not installed. Install with: pip install pip-audit${NC}"
    FAILED=1
fi

echo ""

# ── Node.js dependency audit ────────────────────────────────────────
echo -e "${YELLOW}[2/2] Node.js dependencies (npm audit)${NC}"
if [ -d "dashboard" ]; then
    cd dashboard
    if npm audit --omit=dev 2>&1; then
        echo -e "${GREEN}  ✓ No known Node.js vulnerabilities${NC}"
    else
        echo -e "${RED}  ✗ Node.js vulnerabilities found — see above${NC}"
        FAILED=1
    fi
    cd ..
else
    echo -e "${RED}  ✗ dashboard/ directory not found${NC}"
    FAILED=1
fi

echo ""
echo "========================================="
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}  All security checks passed${NC}"
else
    echo -e "${RED}  Some checks failed — review output above${NC}"
fi
echo "========================================="

exit $FAILED
