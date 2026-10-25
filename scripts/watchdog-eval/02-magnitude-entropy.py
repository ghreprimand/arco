#!/usr/bin/env python3
"""
Watchdog detector v2 — test whether a TIGHTER rule separates real loops from
healthy churn. v1 fired on everything (K=4 catches normal edit->fmt->test
iteration). Real loops should differ in MAGNITUDE (same thing 10-30x) and
ENTROPY COLLAPSE (few distinct actions over a long span). Measure both per
worker and rank, so we can see if any threshold cleanly separates.
"""
import json, glob, collections, os

import os
LOGDIR = os.environ.get("WATCHDOG_LOGDIR", os.path.join(os.getcwd(), ".archon", "workflows"))

def norm_input(tool, raw):
    try: d = json.loads(raw) if isinstance(raw,str) else (raw or {})
    except: d = {"_raw":str(raw)}
    if not isinstance(d,dict): d={"_raw":str(d)}
    if tool=="Bash": return ("Bash", d.get("command","")[:200])
    if tool in ("Edit","Write","apply_patch","NotebookEdit"):
        p = d.get("file_path","") or (d.get("paths") or [""])[0]
        return (tool, str(p))
    if tool in ("Read","Grep","Glob"): return (tool, f'{d.get("file_path","")}{d.get("pattern","")}')
    return (tool, json.dumps(d,sort_keys=True)[:120])

def load_calls(path):
    calls={}; order=0
    for l in open(path):
        if not l.strip(): continue
        try: e=json.loads(l)
        except: continue
        if e.get("type")!="primary_tool_use": continue
        tid=e.get("toolUseId") or f"_{e.get('seq')}"
        if tid not in calls:
            calls[tid]={"sig":norm_input(e.get("tool"),e.get("input")),"ts":e.get("ts"),"order":order}; order+=1
    return [c for c in sorted(calls.values(),key=lambda c:c["order"])]

def analyze(seq):
    sigs=[c["sig"] for c in seq]
    n=len(sigs)
    # 1) global max repeats of any single signature
    gc=collections.Counter(sigs)
    top=gc.most_common(3)
    # 2) tightest burst: max occurrences of one sig within any 30-call window
    W=30; burst=0; burst_sig=None
    for i in range(n):
        w=sigs[i:i+W]
        c=collections.Counter(w).most_common(1)[0]
        if c[1]>burst: burst=c[1]; burst_sig=c[0]
    # 3) entropy collapse: min distinct sigs in any 30-call window, + its time span
    lowent=99; lowent_span=0
    for i in range(n-W+1):
        w=sigs[i:i+W]; distinct=len(set(w))
        span=(seq[i+W-1]["ts"]-seq[i]["ts"])/1000
        if distinct<lowent: lowent=distinct; lowent_span=span
    return {"n":n,"top":top,"burst":burst,"burst_sig":burst_sig,"lowent":lowent if n>=W else None,"lowent_span":round(lowent_span,0)}

def main():
    rows=[]
    for f in sorted(glob.glob(os.path.join(LOGDIR,"*/events.jsonl"))):
        wf=f.split("/")[-2][:8]
        seq=load_calls(f)
        if len(seq)<10: continue
        a=analyze(seq); a["wf"]=wf; rows.append(a)
    rows.sort(key=lambda r:r["burst"],reverse=True)
    print("%-10s %6s %7s %9s  %s" % ("worker","calls","maxrep","minEntropy","tightest-burst (one sig within 30 calls)"))
    print("-"*110)
    for r in rows:
        le = f"{r['lowent']}/30 in {int(r['lowent_span'])}s" if r['lowent'] is not None else "n/a"
        bs = f"{r['burst_sig'][0]}:{str(r['burst_sig'][1])[:38]}" if r['burst_sig'] else ""
        print("%-10s %6d %7d %9s  ×%d %s" % (r["wf"], r["n"], r["top"][0][1], le, r["burst"], bs))
    print()
    print("READING: 'maxrep'=most any single action repeats across the whole run;")
    print("'minEntropy'=fewest distinct actions in any 30-call window (lower=more stuck);")
    print("'tightest-burst'=most times one exact action recurs within a 30-call window.")

if __name__=="__main__": main()
