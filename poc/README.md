# Feasibility probe

Minimal plain-JS extension (`probe-extension/`) that exposes integrated-browser tabs (proposed `browser` API + CDP)
and terminals (stable API + shell integration) over a token-protected local HTTP API. PoC only.

    python3 -m http.server 3917 --bind 127.0.0.1 -d testpage &   # test page
    ./launch.sh /tmp/vsc-probe-wsA [/tmp/vsc-probe-wsB]          # isolated VS Code (own user-data/extensions dir), one window per folder
    ./probe.sh GET /tabs                                          # PROBE_PID=<ext-host pid> selects a window
    ./probe.sh POST /command '{"command":"workbench.action.browser.open","args":["http://127.0.0.1:3917/"]}'
    ./probe.sh POST /click '{"tab":"tab-1","selector":"#btn"}'
    ./probe.sh POST /terminal/create '{"name":"Agent"}'
    ./probe.sh POST /terminal/exec '{"id":"term-1","command":"echo hi"}'

Routes: see `routes` in `probe-extension/extension.js`. Results: `../docs/feasibility-assessment.md`.
