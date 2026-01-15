#!/bin/bash

# Script to find single-word messages in en.json and identify duplicates
# that should be consolidated into common_ namespace

EN_JSON="messages/en.json"

echo "=== Single-Word Message Analysis ==="
echo ""

# Extract all key-value pairs where the value is a single word (no spaces, no parameters)
# Format: "key": "Value" where Value has no spaces and no {params}
echo "=== All Single-Word Messages ==="
grep -E '"[^"]+": "[^" {}]+"' "$EN_JSON" | grep -v '^\s*"\$schema"' | while read -r line; do
    key=$(echo "$line" | sed 's/.*"\([^"]*\)": ".*/\1/')
    value=$(echo "$line" | sed 's/.*": "\([^"]*\)".*/\1/')
    echo "$value|$key"
done | sort

echo ""
echo "=== Duplicate Values (same text, different keys) ==="
echo ""

# Find duplicate values and group their keys
grep -E '"[^"]+": "[^" {}]+"' "$EN_JSON" | grep -v '^\s*"\$schema"' | while read -r line; do
    key=$(echo "$line" | sed 's/.*"\([^"]*\)": ".*/\1/')
    value=$(echo "$line" | sed 's/.*": "\([^"]*\)".*/\1/')
    echo "$value|$key"
done | sort | awk -F'|' '
{
    values[$1] = values[$1] ? values[$1] "," $2 : $2
    count[$1]++
}
END {
    for (v in values) {
        if (count[v] > 1) {
            print "\"" v "\" (" count[v] " occurrences):"
            split(values[v], keys, ",")
            has_common = 0
            for (i in keys) {
                if (keys[i] ~ /^common_/) has_common = 1
                print "  - " keys[i]
            }
            if (!has_common) {
                print "  >>> NEEDS common_ key"
            }
            print ""
        }
    }
}'

echo ""
echo "=== Entity-Scoped Single Words That Could Be Common ==="
echo ""

# Find entity-scoped single words that don't have a common_ equivalent
grep -E '"[^"]+": "[^" {}]+"' "$EN_JSON" | grep -v '^\s*"\$schema"' | grep -v '"common_' | while read -r line; do
    key=$(echo "$line" | sed 's/.*"\([^"]*\)": ".*/\1/')
    value=$(echo "$line" | sed 's/.*": "\([^"]*\)".*/\1/')
    # Check if there's already a common_ version of this value
    common_exists=$(grep -c "\"common_[^\"]*\": \"$value\"" "$EN_JSON" 2>/dev/null || echo "0")
    if [ "$common_exists" = "0" ]; then
        echo "$value|$key|NO_COMMON"
    else
        echo "$value|$key|HAS_COMMON"
    fi
done | sort | grep "NO_COMMON" | awk -F'|' '{print $1 " -> " $2}'

echo ""
echo "=== Summary ==="
total_single=$(grep -E '"[^"]+": "[^" {}]+"' "$EN_JSON" | grep -v '^\s*"\$schema"' | wc -l)
common_single=$(grep -E '"common_[^"]+": "[^" {}]+"' "$EN_JSON" | wc -l)
entity_single=$((total_single - common_single))
echo "Total single-word messages: $total_single"
echo "Common namespace: $common_single"
echo "Entity-specific: $entity_single"
