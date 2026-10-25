#!/usr/bin/env python3
"""
Watchdog detector v3 — ERROR-PERSISTENCE, the signal we actually chose.

v1/v2 (action repetition + entropy) couldn't separate loops from healthy churn.
The hypothesis now: a real loop is the SAME action FAILING repeatedly with NO
success interleaved. Healthy iteration fails then SUCCEEDS (exit toggles) and
moves on. This keys on `status` (failed/completed) — already well-captured in
existing logs — plus exitCode/outputHash where present (the new instrumentation
will make this universal). Runnable NOW on current logs as the real falsification.
"""
import json, glob, collections, os

LOGDIR = os.environ.get("WATCHDOG_LOGDIR", os.path.join(os.getcwd(), ".archon", "workflows"))
PERSIST_K = 4   # same action failing this many times with no success between

def norm_input(tool, raw):
    try: d = json.loads(raw) if isinstance(raw,str) else (raw or {})
    except: d = {"_raw":str(raw)}
    if not isinstance(d,dict): d={"_raw":str(d)}
    if tool=="Bash": return d.get("command","")[:200]
    if tool in ("Edit","Write","apply_patch","NotebookEdit"):
        return str(d.get("file_path","") or (d.get("paths") or [""])[0])
    return json.dumps(d,sort_keys=True)[:120]

def load_calls(path):
    calls={}; order=0
    for l in open(path):
        if not l.strip(): continue
        try: e=json.loads(l)
        except: continue
        if e.get("type")!="primary_tool_use": continue
        tid=e.get("toolUseId") or f"_{e.get('seq')}"
        c=calls.get(tid)
        if not c:
            c={"tool":e.get("tool"),"sig":norm_input(e.get("tool"),e.get("input")),
               "ts":e.get("ts"),"status":e.get("status"),"exit":e.get("exitCode"),
               "ohash":e.get("outputHash"),"order":order}; calls[tid]=c; order+=1
        else:
            if e.get("status"): c["status"]=e.get("status")
            if e.get("exitCode") is not None: c["exit"]=e.get("exitCode")
            if e.get("outputHash"): c["ohash"]=e.get("outputHash")
    return [c for c in sorted(calls.values(),key=lambda c:c["order"])]

def failing(c):
    if c.get("exit") is not None: return c["exit"]!=0
    return c.get("status")=="failed"
def succeeding(c):
    if c.get("exit") is not None: return c["exit"]==0
    return c.get("status")=="completed"

def detect_persistence(seq):
    """For each (tool,sig), walk its occurrences in order; find the longest run
    of FAILURES with no success interleaved. Flag runs >= PERSIST_K."""
    by_sig=collections.defaultdict(list)
    for c in seq: by_sig[(c["tool"],c["sig"])].append(c)
    flags=[]
    for (tool,sig),occ in by_sig.items():
        run=[]; best=[]
        for c in occ:
            if failing(c): run.append(c)
            elif succeeding(c):
                if len(run)>len(best): best=run
                run=[]
            # unknown status: don't break the run, don't extend it
        if len(run)>len(best): best=run
        if len(best)>=PERSIST_K:
            span=(best[-1]["ts"]-best[0]["ts"])/1000
            same_out = len({c.get("ohash") for c in best if c.get("ohash")})<=1 and any(c.get("ohash") for c in best)
            flags.append({"tool":tool,"sig":sig[:80],"fails":len(best),
                          "span_s":round(span,0),"same_output":same_out,
                          "ever_succeeds": any(succeeding(c) for c in occ)})
    return sorted(flags,key=lambda f:-f["fails"])

def main():
    print("ERROR-PERSISTENCE DETECTOR (v3) — same action failing >= %d times, no success interleaved" % PERSIST_K)
    print("(status-based today; exitCode/outputHash fill in once instrumentation deploys)\n")
    any_red=False
    for f in sorted(glob.glob(os.path.join(LOGDIR,"*/events.jsonl"))):
        wf=f.split("/")[-2][:8]
        seq=load_calls(f)
        if len(seq)<10: continue
        flags=detect_persistence(seq)
        # count how many distinct tool calls have ANY status captured (sanity)
        with_status=sum(1 for c in seq if c.get("status") or c.get("exit") is not None)
        mark="🔴" if flags else "🟢"
        if flags: any_red=True
        print(f"{mark} {wf}  ({len(seq)} calls, {with_status} with pass/fail signal) — {len(flags)} persistence flag(s)")
        for x in flags[:6]:
            tail = "SAME output" if x["same_output"] else ("recovers later" if x["ever_succeeds"] else "never succeeds")
            print(f"     ✗{x['fails']}× {x['tool']} over {int(x['span_s'])}s [{tail}] : {x['sig']}")
    if not any_red:
        print("\n(no worker showed >=%d consecutive same-action failures — either none looped, or pass/fail signal too sparse)" % PERSIST_K)

if __name__=="__main__": main()
