# watchdog-eval

Offline, read-only falsification harness for the cluster worker-watchdog. Each
script replays real worker `events.jsonl` logs and reports what a candidate
loop-detector *would* have flagged — so detectors are validated against ground
truth before any halt logic ships. Full context: `docs/WATCHDOG_PLAN.md`.

**A worker is misbehaving and you want to analyze it?** Step-by-step incident
runbook (find the log, run both detectors, interpret, confirm with raw
evidence): `docs/WATCHDOG_PLAN.md` § 6.5.

```bash
# default log dir is .archon/workflows under the current directory; override per project:
WATCHDOG_LOGDIR=~/Projects/<proj>/.archon/workflows python3 scripts/watchdog-eval/03-error-persistence.py
```

- `01-naive-repetition.py` — repeated `(tool,input)` signatures. **Falsified** (fires on all healthy work).
- `02-magnitude-entropy.py` — burst magnitude + action-entropy collapse. **Falsified** (benign work outranks real degeneracy).
- `03-error-persistence.py` — same action failing ≥K× with no success interleaved (Type A). **Safe** (zero false positives) but catch-rate unproven; the live candidate.
- `04-progress-proxy.py` — Type-B spin: a dense, low-diversity burst with zero progress events (commit / task-complete / new file / fail→pass). Cleanly flags the one real mailbox-poll spin in the sample, green on all 13 healthy workers; catch-rate beyond that needs a live incident.
