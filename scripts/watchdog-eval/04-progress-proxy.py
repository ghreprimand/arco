#!/usr/bin/env python3
"""
Watchdog detector v4 — TYPE-B progress-proxy (spin-loop).

Type-A (error-persistence) is blind to the spin loop: a worker repeating
*succeeding* / no-op actions, making no real progress. The discriminator can't
be "is it repetitive" (healthy heavy work is too) — it must be "is it ADVANCING."

A window is flagged SPIN when, over >=N tool calls spanning >=M minutes:
  (1) the distinct-action ratio is low (revisiting, not exploring breadth), AND
  (2) ZERO progress events occurred.
Progress event = any of: a git commit; a task-ledger advance / task_complete;
a completion peer_send; a globally-new file edited; a fail->pass transition.

Clause (2) is the real discriminator — healthy workers, even grinding on one
file, eventually commit / pass a test / check a task. Clause (1) guards against
flagging legitimate broad exploration (many DIFFERENT reads).

CAVEAT: existing logs have no outputHash and partial exitCode, so fail->pass
uses `status`. And the operator's real spin incidents may not be in this sample
(killed workers) — so this measures the FALSE-POSITIVE rate on known-healthy
workers (necessary condition); true catch-rate needs a live incident.
"""
import json, glob, collections, os, re

LOGDIR = os.environ.get("WATCHDOG_LOGDIR", os.path.join(os.getcwd(), ".arco", "workflows"))
WIN_CALLS = 20        # window size in tool calls
WIN_MIN   = 6         # ...spanning at least this many minutes
DISTINCT_RATIO = 0.45 # flag only if distinct (tool,sig)/calls below this (revisiting)
DISTINCT_MAX = 6      # ...AND few distinct actions in absolute terms. A spin loop
                      # cycles a tiny set (poll, re-read, re-run); varied work that
                      # merely missed a progress marker has high absolute diversity.
GAP_MAX_S = 180       # an inter-call gap longer than this ends the active burst
                      # (idle != spin — idle is the nudger's job, not the watchdog's)

COMPLETE_RE = re.compile(r'\b(COMPLETE|COMPLETION|DONE|SHIPPED|PACKET COMPLETE)\b', re.I)

def norm_input(tool, raw):
    try: d = json.loads(raw) if isinstance(raw,str) else (raw or {})
    except: d = {"_raw":str(raw)}
    if not isinstance(d,dict): d={"_raw":str(d)}
    if tool=="Bash": return d.get("command","")[:200]
    if tool in ("Edit","Write","apply_patch","NotebookEdit"):
        return str(d.get("file_path","") or (d.get("paths") or [""])[0])
    return json.dumps(d,sort_keys=True)[:120]

def edited_path(tool, raw):
    if tool not in ("Edit","Write","apply_patch","NotebookEdit"): return None
    try: d = json.loads(raw) if isinstance(raw,str) else (raw or {})
    except: return None
    if not isinstance(d,dict): return None
    return d.get("file_path") or (d.get("paths") or [None])[0]

def load(path):
    """Return ordered tool calls (deduped by id) + standalone progress markers."""
    calls={}; order=0; ledger_ts=[]
    for l in open(path):
        if not l.strip(): continue
        try: e=json.loads(l)
        except: continue
        t=e.get("type")
        if t=="task_ledger_event":
            ledger_ts.append(e.get("ts"))
        elif t=="primary_tool_use":
            tid=e.get("toolUseId") or f"_{e.get('seq')}"
            c=calls.get(tid)
            if not c:
                c={"tool":e.get("tool"),"input":e.get("input"),"ts":e.get("ts"),
                   "status":e.get("status"),"order":order}; calls[tid]=c; order+=1
            elif e.get("status"): c["status"]=e.get("status")
    return [c for c in sorted(calls.values(),key=lambda c:c["order"])], ledger_ts

def mark_progress(seq, ledger_ts):
    """Return a parallel bool list: did a progress event occur AT this call?"""
    seen_paths=set(); last_status={}; prog=[False]*len(seq)
    ledger=set(ledger_ts)
    for i,c in enumerate(seq):
        tool=c["tool"]; sig=norm_input(tool,c["input"]); p=False
        cmd = sig if tool=="Bash" else ""
        if tool=="Bash" and "git commit" in cmd and c.get("status")!="failed": p=True
        if "task_complete" in (tool or "").lower(): p=True
        if (tool or "").endswith("peer_send"):
            try:
                d=json.loads(c["input"]) if isinstance(c["input"],str) else {}
                if isinstance(d,dict) and COMPLETE_RE.search(str(d.get("content",""))): p=True
            except: pass
        ep=edited_path(tool,c["input"])
        if ep and ep not in seen_paths: p=True; seen_paths.add(ep)
        # fail -> pass transition on the same signature
        st=c.get("status")
        if st=="completed" and last_status.get(sig)=="failed": p=True
        if st in ("completed","failed"): last_status[sig]=st
        prog[i]=p
    return prog

def bursts(seq):
    """Segment calls into active bursts; a gap > GAP_MAX_S starts a new burst.
    Spin is DENSE activity — idle (long gaps) is the nudger's domain, not ours."""
    if not seq: return []
    out=[[0]]
    for k in range(1,len(seq)):
        if (seq[k]["ts"]-seq[k-1]["ts"])/1000 > GAP_MAX_S: out.append([k])
        else: out[-1].append(k)
    return out

def find_spin(seq, prog):
    flags=[]
    def sig_of(k): return (seq[k]["tool"], norm_input(seq[k]["tool"], seq[k]["input"]))
    for burst in bursts(seq):
        if len(burst) < WIN_CALLS: continue
        # slide a no-progress window WITHIN the burst only
        i=0
        while i < len(burst):
            # grow the no-progress run from burst position i
            j=i
            while j < len(burst) and not prog[burst[j]]: j+=1
            run=burst[i:j]
            if len(run) >= WIN_CALLS:
                span=(seq[run[-1]]["ts"]-seq[run[0]]["ts"])/60000
                distinct=len({sig_of(k) for k in run})
                if span >= WIN_MIN and distinct <= DISTINCT_MAX and distinct/len(run) < DISTINCT_RATIO:
                    flags.append({"calls":len(run),"span_min":round(span,1),"distinct":distinct,
                                  "top":collections.Counter(sig_of(k) for k in run).most_common(1)[0]})
            i = j+1 if j < len(burst) else j
    return flags

def main():
    print(f"TYPE-B PROGRESS-PROXY (v4) — spin = >={WIN_CALLS} calls / >={WIN_MIN}min, distinct-ratio<{DISTINCT_RATIO}, ZERO progress events")
    print("progress = git commit | task_complete | completion peer_send | new file edited | fail->pass\n")
    any_red=False
    for f in sorted(glob.glob(os.path.join(LOGDIR,"*/events.jsonl"))):
        wf=f.split("/")[-2][:8]
        seq,ledger=load(f)
        if len(seq)<WIN_CALLS: continue
        prog=mark_progress(seq,ledger)
        flags=find_spin(seq,prog)
        ptot=sum(prog)
        mark="🔴" if flags else "🟢"
        if flags: any_red=True
        print(f"{mark} {wf}  ({len(seq)} calls, {ptot} progress events) — {len(flags)} spin window(s)")
        for x in flags[:5]:
            (tool,sig),cnt=x["top"]
            print(f"     ⟳ {x['calls']} calls / {x['span_min']}min, {x['distinct']} distinct, no progress — dominant {tool}:{sig[:50]} (×{cnt})")
    if not any_red:
        print("\n(no spin windows — healthy workers stayed quiet; necessary condition met)")

if __name__=="__main__": main()
