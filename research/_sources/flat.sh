#!/usr/bin/env bash
# flat.sh START END [--json]
# Reads a line range out of the CoinDCX docs text dump and prints it compactly:
#   default : prose + tables only (multi-language code samples stripped, table cells reflowed to one row per line)
#   --json  : only the fenced blocks that look like JSON (the response samples)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS="$DIR/coindcx-docs.txt"
START="$1"; END="$2"; MODE="${3:-prose}"

if [ "$MODE" = "--json" ]; then
  sed -n "${START},${END}p" "$DOCS" | awk '
    BEGIN { f=0; buf=""; isj=0 }
    /^```$/ {
      if (f==0) { f=1; buf=""; isj=0 }
      else      { f=0; if (isj) print buf "\n---BLOCK---" }
      next
    }
    f==1 { if (buf=="" && ($0 ~ /^[[{]/)) isj=1; buf = buf "\n" $0 }
  '
  exit 0
fi

sed -n "${START},${END}p" "$DOCS" \
| awk 'BEGIN{f=0} /^```$/{f=!f; next} f==0{print}' \
| grep -v '^[[:space:]]*$' \
| awk '
    function flush() { if (n>0) { printf "%s|\n", row; row=""; n=0 } }
    /^[[:space:]]*\|[[:space:]]*$/ { flush(); next }
    /^[[:space:]]*\|[[:space:]]/ {
      c=$0
      sub(/^[[:space:]]*\|[[:space:]]*/, "", c)
      gsub(/[[:space:]]+$/, "", c)
      row = row "| " c " "; n++; next
    }
    { flush(); print }
    END { flush() }
  '
