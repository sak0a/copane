#!/bin/sh
# usage: [PROBE_PID=<ext-host pid>] probe.sh METHOD PATH [JSON]   (default: newest probe instance)
D="${TMPDIR:-/tmp}"
INFO=${PROBE_PID:+$D/vsc-probe-$PROBE_PID.json}; INFO=${INFO:-$(ls -t "$D"/vsc-probe-*.json | head -1)}
P=$(node -p "require('$INFO').port"); T=$(node -p "require('$INFO').token")
curl -s -X "$1" -H "x-probe-token: $T" -H 'content-type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$P$2"
