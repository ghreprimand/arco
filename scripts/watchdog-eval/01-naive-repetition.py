#!/usr/bin/env python3
"""
Watchdog detector evaluator — offline replay of real cluster-worker event logs.

Falsification harness for the cluster worker-watchdog idea: replay each worker's
events.jsonl, run candidate STALL / LOOP / RUNAWAY detectors over the reconstructed
tool-call stream, and report what each would have flagged — so we can eyeball
whether the flags land on the runs that actually looped (true positives) vs the
healthy `cargo` grind (false positives) BEFORE any halt logic ships.

No server code, no halting — pure read-only analysis of logs on disk.
"""
import json, glob, hashlib, collections, datetime, os, sys

# Point at any project's worker logs: WATCHDOG_LOGDIR=/path/to/<proj>/.archon/workflows
LOGDIR = os.environ.get("WATCHDOG_LOGDIR", os.path.join(os.getcwd(), ".archon", "workflows"))

# ---- thresholds (the whole game is tuning these) -------------------------
LOOP_REPEAT_K   = 4     # same (tool,input) this many times...
LOOP_WINDOW_W   = 10    # ...within this many consecutive distinct calls
CYCLE_MIN_REPS  = 3     # an A,B(,C) cycle repeating >= this many times
STALL_GAP_S     = 90    # silence after a COMPLETED tool, turn still open
RUNAWAY_TOOLS_PER_TURN = 60     # distinct tool calls in one turn
RUNAWAY_TURN_MINUTES   = 20     # wall-clock turn duration

def norm_input(tool, raw):
    """Normalize a tool input to a progress-bearing signature.
    For Bash, the command string is what matters; for edits, the file+payload."""
    try:
        d = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        d = {"_raw": str(raw)}
    if not isinstance(d, dict):
        d = {"_raw": str(d)}
    if tool == "Bash":
        sig = d.get("command", "")
    elif tool in ("Edit", "Write", "NotebookEdit"):
        sig = f'{d.get("file_path","")}|{d.get("old_string","")[:120]}|{d.get("new_string","")[:120]}|{d.get("content","")[:120]}'
    elif tool in ("Read", "Grep", "Glob"):
        sig = f'{d.get("file_path","")}{d.get("pattern","")}{d.get("path","")}'
    else:
        sig = json.dumps(d, sort_keys=True)[:300]
    return sig.strip()

def load_calls(path):
    """Reconstruct distinct tool calls (grouped by toolUseId) + turn boundaries."""
    calls = {}      # toolUseId -> {tool,input,ts,status,output,exitCode,order}
    order = 0
    turns = []      # (startedAt, endedAt|None)
    events = []
    for l in open(path):
        if not l.strip(): continue
        try: e = json.loads(l)
        except: continue
        events.append(e)
    for e in events:
        t = e.get("type")
        if t == "primary_turn_started":
            turns.append([e.get("ts"), None])
        elif t == "primary_turn_ended":
            if turns and turns[-1][1] is None: turns[-1][1] = e.get("ts")
            else: turns.append([None, e.get("ts")])
        elif t == "primary_tool_use":
            tid = e.get("toolUseId") or f"_{e.get('seq')}"
            c = calls.get(tid)
            if not c:
                c = {"tool": e.get("tool"), "input": e.get("input"),
                     "ts": e.get("ts"), "status": e.get("status"),
                     "output": e.get("output"), "exitCode": e.get("exitCode"),
                     "order": order}
                calls[tid] = c; order += 1
            else:
                # later status update (completed/failed) — keep richest
                if e.get("status"): c["status"] = e.get("status")
                if e.get("output") is not None: c["output"] = e.get("output")
                if e.get("exitCode") is not None: c["exitCode"] = e.get("exitCode")
    seq = sorted(calls.values(), key=lambda c: c["order"])
    return seq, turns

def detect_loops(seq):
    """Flag windows where one (tool,input) signature repeats, or a short cycle repeats.
    Annotate whether OUTPUTS are identical too (no-progress) vs varying (maybe legit)."""
    flags = []
    sigs = [(c["tool"], norm_input(c["tool"], c["input"])) for c in seq]
    outs = [str(c.get("output"))[:200] for c in seq]
    n = len(sigs)
    # (a) same-signature saturation within a sliding window
    i = 0
    used = [False]*n
    while i < n:
        j = min(i+LOOP_WINDOW_W, n)
        window = sigs[i:j]
        cnt = collections.Counter(window)
        sig, c = cnt.most_common(1)[0]
        if c >= LOOP_REPEAT_K and not used[i]:
            idxs = [k for k in range(i, j) if sigs[k]==sig]
            for k in idxs: used[k]=True
            out_set = set(outs[k] for k in idxs)
            t0, t1 = seq[idxs[0]]["ts"], seq[idxs[-1]]["ts"]
            flags.append({"kind":"saturate","tool":sig[0],"sig":sig[1][:140],
                          "count":c,"span_s":round((t1-t0)/1000,1),
                          "no_progress": len(out_set)<=1,
                          "exit_codes": sorted(set(seq[k].get("exitCode") for k in idxs), key=lambda v: (v is None, v))})
            i = idxs[-1]+1
        else:
            i += 1
    # (b) short cycle A,B(,C) repeating
    for period in (2,3):
        k = 0
        while k + period*CYCLE_MIN_REPS <= n:
            block = sigs[k:k+period]
            reps = 1
            m = k+period
            while m+period <= n and sigs[m:m+period]==block:
                reps += 1; m += period
            if reps >= CYCLE_MIN_REPS and len(set(block))>1:
                t0,t1 = seq[k]["ts"], seq[m-1]["ts"]
                flags.append({"kind":f"cycle{period}","tools":[b[0] for b in block],
                              "reps":reps,"span_s":round((t1-t0)/1000,1),
                              "sample":[b[1][:60] for b in block]})
                k = m
            else:
                k += 1
    return flags

def detect_stalls(seq):
    flags=[]
    for a,b in zip(seq, seq[1:]):
        if a.get("status") in ("completed","failed") or a.get("status") is None:
            gap = (b["ts"]-a["ts"])/1000
            if gap >= STALL_GAP_S:
                flags.append({"gap_s":round(gap,1),"after_tool":a["tool"],
                              "after_sig":norm_input(a["tool"],a["input"])[:80]})
    # trailing in-flight tool (started, never completed) = possible hang at kill
    if seq and seq[-1].get("status")=="started":
        flags.append({"gap_s":None,"after_tool":seq[-1]["tool"],
                      "after_sig":norm_input(seq[-1]["tool"],seq[-1]["input"])[:80],
                      "note":"ended in-flight (killed or hung)"})
    return flags

def detect_runaway(seq, turns):
    flags=[]
    # assign calls to turns by timestamp
    for st,en in turns:
        if st is None: continue
        end = en if en else (seq[-1]["ts"] if seq else st)
        within = [c for c in seq if st <= c["ts"] <= end]
        mins = round((end-st)/60000,1)
        if len(within) >= RUNAWAY_TOOLS_PER_TURN:
            flags.append({"why":"tool_count","tools":len(within),"minutes":mins})
        elif mins >= RUNAWAY_TURN_MINUTES and len(within) >= 10:
            flags.append({"why":"duration","tools":len(within),"minutes":mins})
    return flags

def main():
    files = sorted(glob.glob(os.path.join(LOGDIR,"*/events.jsonl")))
    rows=[]
    for f in files:
        wf = f.split("/")[-2][:8]
        seq, turns = load_calls(f)
        if not seq: continue
        loops = detect_loops(seq)
        stalls = detect_stalls(seq)
        runaway = detect_runaway(seq, turns)
        # loop severity score: weight no-progress saturations highest
        sat_np = sum(1 for x in loops if x["kind"]=="saturate" and x["no_progress"])
        sat    = sum(1 for x in loops if x["kind"]=="saturate")
        cyc    = sum(1 for x in loops if x["kind"].startswith("cycle"))
        rows.append((wf,len(seq),len(turns),loops,stalls,runaway,sat_np,sat,cyc))
    # sort by no-progress saturations desc
    rows.sort(key=lambda r:(r[6],r[7],r[8]), reverse=True)
    print("="*100)
    print("WATCHDOG DETECTOR EVALUATION — %d worker logs" % len(rows))
    print("thresholds: LOOP same-sig>=%d in %d calls | cycle x%d | stall>=%ds | runaway>=%d tools/turn or >=%dmin"
          % (LOOP_REPEAT_K,LOOP_WINDOW_W,CYCLE_MIN_REPS,STALL_GAP_S,RUNAWAY_TOOLS_PER_TURN,RUNAWAY_TURN_MINUTES))
    print("="*100)
    for wf,nc,nt,loops,stalls,runaway,sat_np,sat,cyc in rows:
        hot = "🔴" if sat_np else ("🟠" if (sat or cyc) else "🟢")
        print(f"\n{hot} {wf}  | {nc} tool-calls, {nt} turns | loop-flags: {sat_np} no-progress, {sat-sat_np} progressing-repeat, {cyc} cycle | stalls: {len(stalls)} | runaway: {len(runaway)}")
        for x in loops:
            if x["kind"]=="saturate":
                tag = "NO-PROGRESS (same output)" if x["no_progress"] else "repeating (output varies)"
                print(f"    ↻ {x['tool']} ×{x['count']} in {x['span_s']}s [{tag}] exit={x['exit_codes']}  : {x['sig']}")
            else:
                print(f"    ↻ {x['kind']} ×{x['reps']} in {x['span_s']}s : {' -> '.join(x['tools'])}  {x['sample']}")
        for s in stalls[:5]:
            g = f"{s['gap_s']}s" if s['gap_s'] else s.get('note','')
            print(f"    ⏸ stall {g} after {s['after_tool']} : {s['after_sig']}")
        if len(stalls)>5: print(f"    ⏸ (+{len(stalls)-5} more stalls)")
        for r in runaway:
            print(f"    ⚡ runaway turn: {r['tools']} tools / {r['minutes']}min ({r['why']})")

if __name__=="__main__":
    main()
