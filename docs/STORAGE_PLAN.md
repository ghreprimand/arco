# Storage plan

This page explains where Arco's disk space goes, what Arco will change to use less of it, and how saved history stays readable through those changes. It is for the operator reviewing the storage work and for the builders implementing it. Nothing described here deletes anything without an operator click.

## Summary

- The large items are agent-made copies of projects with their build output, artifacts (mostly virtual machine disk images), browser caches and voice environments. Conversation logs are smaller but grow without limit.
- Half of all conversation-log bytes are repeated full copies of the task board. P7.2 stops writing them.
- Old log pieces compress very well. P7.3 seals them into compressed files; nothing is deleted and every reader still sees the full history.
- Artifacts get size warnings with a permanent approval (P7.4). Closed conversations can be archived or deleted on the operator's click (P7.5). Plans are never touched.

## Plans are permanent

Plans (`<project>/.arco/plans/<id>.md`, their `.refs/` folders and the plan history in `plans/.history/`) are stored apart from conversation folders. No sealing, archive, delete, scratch clean-up, size warning or disk-budget action in P7.2 to P7.5 touches them, and plans need no KEEP mark. Tests assert that sealing a log, and later archiving or deleting a conversation, leaves every plan and reference doc in place.

## Where the space goes

### How it was measured

The storage report (USAGE > **MEASURE STORAGE** and **MEASURE ARCO FOLDER**) walks a state folder in a background worker and puts every file into exactly one bucket. Rules:

- Sizes are logical file sizes. The allocated size on disk is reported beside them.
- A file with several hard links is counted once. The extra links are reported separately.
- A project state folder inside another state folder (chat and Genesis projects inside Arco's own folder) is skipped there and measured as its own project.
- Links to other places are never followed. Nothing is written.

Two sets of state folders on one machine were measured, read-only. Set A is Arco's own state. Set B is state with the same folder layout, written by an earlier version of the software over several months of heavy use. Set B shows what Arco's state grows into; Set A is still small.

### Totals

| | Set A | Set B |
| --- | --- | --- |
| Project state folders | 45 | 144 |
| Project state, logical | 5.4 MB | 116.5 GB |
| Extra hard links (not counted again) | 0 | 7.8 GB |
| Arco's own folder | 1.71 GB | 58.8 GB |
| Nested project state folders skipped in Arco's own folder | 1 | 28 |

The earlier report counted hard links twice and counted the chat projects inside Arco's own folder twice. The figures above remove both.

### Project state by bucket (Set B)

| Bucket | Bytes | Share |
| --- | --- | --- |
| Worktrees and isolated copies | 62.0 GB | 53% |
| Artifacts | 43.9 GB | 38% |
| Conversation logs | 8.0 GB | 7% |
| Other (an audit folder and built programs) | 1.8 GB | 2% |
| Scratch files | 0.48 GB | under 1% |
| Other conversation files | 0.33 GB | under 1% |
| Task boards | 0.02 GB | under 1% |
| Plans | under 0.01 GB | under 1% |

### The largest project (Set B)

| Bucket | Bytes |
| --- | --- |
| Worktrees and isolated copies | 61.9 GB (about 54.5 GB of it compiler output in six build folders) |
| Artifacts | 35.5 GB |
| Conversation logs | 5.2 GB |
| Other | 1.6 GB (an audit folder 1.5 GB, built programs 0.2 GB) |
| Total | 104.3 GB (110.9 GB before removing 6.5 GB of extra hard links) |

The 70 GB that the first report could not explain is the worktrees bucket (agents made Git worktrees inside the project's state folder and built in them), the audit folder, and hard links counted twice. The largest project has no nested state folder.

### Arco's own folder

| Bucket | Set A | Set B |
| --- | --- | --- |
| Caches and browser profiles | 0.27 GB | 29.0 GB (one browser profile cache) |
| Voice and media models | 1.40 GB | 18.7 GB (16.4 GB of it Python environments) |
| Provider account data | 0 | 9.7 GB (session files of a separate provider home) |
| Checkpoints | 0.03 GB | 0.84 GB |
| Saved clusters | under 0.01 GB | 0.33 GB |
| Server logs | 0.01 GB | 0.03 GB |
| Other | under 0.01 GB | 0.27 GB |

### Conversation logs (Set B)

- 1,885 logs. The median log is 0.39 MB. 207 logs are above 8 MiB; 42 logs are above 32 MiB and hold 3.5 GB together. The largest is 463 MB.
- By event type: full task board copies 49.7%, tool calls 28.4%, streamed text 9.6%, reasoning 4.6%, plan bodies 0.9%. In Set A, board copies are 5.2%.
- The largest log is 463 MB, of which all but 742 bytes are board copies.

### Artifacts (Set B)

- 674 of 1,895 conversations have artifacts.
- 24 artifact files are 100 MiB or larger, 15 are 500 MiB or larger, 7 are 1 GiB or larger, 1 is larger than 5 GiB.
- Disk images account for 21.2 GB of the large files.
- Two conversations hold more than 5 GiB of artifacts each.

### Compression of logs

Measured on real logs with Node's built-in `zlib`, without writing anything:

| Sample | Uncompressed | gzip | Brotli (quality 5, 16 MiB window) |
| --- | --- | --- | --- |
| 12 logs between 2 and 40 MB | 80 MB | 4.3x smaller | 14.3x smaller |
| A 116 MB log without board copies | 116 MB | 3.8x | 146x |
| The 463 MB board-copy log | 463 MB | 3.4x (5.9 s) | 3,240x (0.8 s) |

gzip only finds repeats within 32 KB, so repeated board copies and long tool outputs do not shrink much. Brotli with a 16 MiB window finds them. Brotli is part of `node:zlib`; it needs no new dependency.

## What was checked in the code

| Claim | Result |
| --- | --- |
| The log is append-only with no rotation | Confirmed. `workflowStore.ts` `persistAndStampSeq` queues records and `flushBuffer` appends. The 100 MB figure in the `INIT_TAIL_READ_BYTES` comment is not enforced. |
| Board copies are needed in the log | Not needed. `taskLedgerHandlers.ts` `broadcastSnapshot` writes a full copy on every change, every `task_ledger_list` and every reconnect (`sendTaskLedgerSnapshot`). The board itself lives in the ledger store (`taskLedger.ts` `load`). Reconnecting tabs get a fresh copy from `sendTaskLedgerSnapshot` and cluster subscriptions (`clusterHandlers.ts`). Recovery uses `task_ledger_event` mutations (`taskLedger.ts` `rebuildFromEvents`). The cluster board copies sent by `clusterPeerOps.ts` already go out live only (`broadcastCluster`). |
| Plan bodies are needed in the log | Not needed for state. `broadcast.ts` `broadcastCluster` copies `cluster_plan_changed` into every member's log as an audit record. The client handler ignores it (`handleServerMessage.ts`). No server code reads the body back. |
| Streamed text can be merged | Not safe. Each delta has its own sequence number and parent link; merging changes reconnect and HISTORY behavior. Compression covers it instead. |
| Reads are bounded | Not always. `replayEvents`, `replayEventsWithTs` and `readEventsPageBefore` read the whole file. `resumeSummary.ts` `replayMessagesWithResumePolicy` reads the whole file for branch history. Compression does not make this worse; P7.3 keeps the same memory profile and reads compressed pieces as a stream. |
| Nothing is ever reclaimed | Too broad. `gitSnapshots.ts` `pruneOldCheckpoints` prunes older checkpoint refs. Closing a conversation keeps its folder; `purgeWorkflow` deletes only on an explicit request. |

## Decisions and recommendations

Each item lists the recommendation, what it costs, and the operator's direction where one was given.

### 1. Task board copies (P7.2, approved)

- **Recommendation:** stop writing full board copies to conversation logs. Keep writing the per-change `task_ledger_event` records. Send board copies to open tabs live only.
- **Trade-off:** a log no longer shows the whole board at a past moment. The board at any point can still be rebuilt from the change records. Old logs keep their copies.
- **Effect:** about half of all log bytes in Set B.

### 2. Plan bodies in logs (P7.2)

- **Recommendation:** store each distinct plan body once in a plan history folder, `<project>/.arco/plans/.history/<sha256>.md`, and log only its hash and length. The history folder sits inside the plans folder, so it is permanent like the plans.
- **Trade-off:** reading an old plan version needs the history file, not just the log. The saving is small (under 1%); the main gain is that a long plan is not copied into every member's log on every tick.

### 3. Streamed text

- **Recommendation:** leave streamed text as it is. Sealed segments compress it.
- **Trade-off:** the live file is larger until it is sealed.

### 4. Log segments (P7.3, approved)

- **Recommendation:** seal the live log when it passes 16 MiB into compressed segments of at most 16 MiB of records each, using Brotli from `node:zlib` (quality 5, 16 MiB window). This differs from the earlier gzip suggestion: Brotli is equally built in and is 3 to 1,000 times more effective on these logs, and faster on the large ones.
- **Trade-off:** fewer outside tools read Brotli than gzip. The export command below turns any log back into one plain file.

### 5. Downgrade (P7.3)

- **Recommendation:** releases from 0.1.4 on write a format marker in each sealed conversation and refuse to write to a log with a newer format than they know. Releases before 0.1.4 cannot refuse; for them, `arco storage unseal` exports every sealed log back into one plain `events.jsonl` before a downgrade.
- **Trade-off:** a downgrade without the export shows only the unsealed part of each history. It does not corrupt anything: the newest record stays in the live file, so sequence numbers continue correctly. Upgrading again shows the full history.

### 6. Artifact warnings and scratch (P7.4, approved with conditions)

- **Recommendation:** warn at write time when one artifact file reaches 1 GiB, or a conversation's artifacts reach 5 GiB. In Set B this would have warned for 7 files and 2 conversations out of 1,895. Approving a warning sets **KEEP** on that file or folder, and it never warns again.
- **Scratch:** each conversation gets `scratch/` beside `artifacts/`, not inside it. Agent guidance says to put large intermediate files there. **EMPTY SCRATCH** deletes it, only on the operator's click and after a confirmation. Kept items are skipped.
- **Trade-off:** files under the thresholds never warn, even when many of them add up. The per-conversation total covers most of that.

### 7. Archive, delete and the disk-budget notice (P7.5, approved)

- **Recommendation:** **ARCHIVE** packs a closed conversation folder into one compressed file next to it and can be restored; **DELETE** removes it after a confirmation. Both are operator clicks. The optional auto-archive rule ("closed more than 30 days") is off by default and never deletes. A disk-budget notice appears when all state folders and Arco's own folder together pass 100 GiB; the number is adjustable and the notice can be turned off.
- **Trade-off:** archiving keeps the bytes of artifacts that are already compressed (disk images, archives), so it frees little for them. Delete is the only way to reclaim those, and it stays a confirmed click.

### 8. One storage page for all projects (approved)

- **Recommendation:** yes. The **STORAGE** view in the ARTIFACTS window lists every known project, largest first, with logs, artifacts, scratch, worktrees and the biggest item, and Arco's own folder as its own row. It reads the same report as USAGE.

### 9. Worktrees and caches (new, needs a decision)

- **Finding:** in Set B the largest bucket is not logs or artifacts but agent-made worktrees inside a project's state folder, mostly compiler output (62 GB). Arco's own folder holds a 29 GB browser cache and 16 GB of voice Python environments.
- **Recommendation:** show these rows on the STORAGE page with their size and, for worktrees, whether they have uncommitted changes. Any clean-up action (deleting a worktree with no uncommitted changes, clearing the browser cache) is a separate decision and is not part of P7.4 or P7.5.

## P7.2 design: stop writing waste

### Board copies

1. Add `sendWorkflowLive(workflowId, message)` in `server/src/server/broadcast.ts`. It sends to the conversation's open tabs without a sequence number and without writing to the log.
2. `taskLedgerHandlers.ts` `broadcastSnapshot` uses it. This covers every caller: the LEDGER mutations, `handleTaskLedgerList`, `sendTaskLedgerSnapshot`, member replacement in `clusterHandlers.ts` and `taskWorktreeHandlers.ts`.
3. `emitEvent` keeps writing `task_ledger_event` through `broadcastWorkflow`, unchanged.
4. Nothing else changes. Cluster board copies already go out live only.

A tab that is closed when the board changes gets the current board when it reconnects (`sendTaskLedgerSnapshot`), or when it opens the board (`task_ledger_list`).

### Plan bodies

1. `server/src/planHistory.ts` adds `rememberPlanBody(cwd, body)`. It writes `<cwd>/.arco/plans/.history/<sha256>.md` once, through a temporary file and a rename, and returns the hash. An empty body (plan cleared) writes nothing.
2. In `broadcastCluster`, the copy written to each member's log replaces `body` with `bodySha256`. `bodyLength` and `updatedAt` stay. Live cluster subscribers still receive the full message.
3. `ClusterPlanChangedMessage` in `shared/src/protocol/clusters.ts` makes `body` optional and adds `bodySha256`.
4. Plan readers that list `plans/` read only top-level `.md` files, so `.history/` does not appear as plans. A test pins that.

### Compatibility of P7.2

| Case | Expected |
| --- | --- |
| Old log with board copies, replayed by new code | The client applies them as before. Cluster restore still keeps only the last copy (`compactRestoredEvents`). |
| New log, reconnect | The board arrives from the live copy sent on reconnect. |
| New log, ledger recovery (`rebuildFromEvents`) | Same board as before, from the change records. |
| New log, saved cluster save and restore | Restores with no board copy in the log; the board comes from the ledger store. |
| Plan change | One history file per distinct body; the logged event has hash and length; the history file equals the body. |
| Old log with plan bodies | Read unchanged. |
| Downgrade to 0.1.3 | Compatible. 0.1.3 sends live board copies itself and ignores the plan event. |

## P7.3 design: sealed, compressed segments

### Files

In each conversation folder:

| File | Meaning |
| --- | --- |
| `events.jsonl` | The live log. Plain text, appended as today. |
| `events.<firstSeq>-<lastSeq>.jsonl.br` | A sealed segment. Brotli-compressed records with sequence numbers `firstSeq` to `lastSeq`, each zero-padded to 12 digits so that name order is sequence order. |
| `log-format.json` | Written when the first segment is sealed: `{ "format": 2 }`. |
| `*.tmp` | An unfinished write. Ignored by readers; removed by the next seal. |

### Sealing

Sealing runs in the conversation's existing flush chain (`flushBuffer`), after an append that leaves the live file at 16 MiB or more. Events keep getting sequence numbers and wait in memory while it runs; nothing waits on the server's event loop.

1. Read the live file as a stream, up to its last complete line.
2. Skip records whose sequence number is at or below the last sealed segment's `lastSeq` (left over from an interrupted seal).
3. Write the records into segments of at most 16 MiB of records each: compress into a `.tmp` file, flush it to disk, rename it to its final name, flush the folder.
4. Read each new segment back and check its record count and last sequence number.
5. Write `log-format.json` if it is missing.
6. Replace the live file with a new one that holds only the last sealed record, through a temporary file and a rename.

The copied last record keeps sequence numbers continuous for a release that reads only `events.jsonl`. New readers skip any live record at or below the last sealed sequence number, so it is never seen twice.

### Crash safety

| Interrupted | On disk | Result |
| --- | --- | --- |
| Before a segment's rename | A `.tmp` file and the full live file | Readers ignore the `.tmp`; the next seal removes it and starts again. |
| After some segments, before the live file is replaced | Segments and the full live file | Readers skip the live records already sealed; the next seal continues after the last sealed record. |
| During the live file replacement | The old or the new live file, never half of one | Both are valid. |

Sequence numbers come from `readLatestSeq`, which reads the live file's tail and, when that is empty, the `lastSeq` in the newest segment's name. They stay monotonic across seals, crashes and restarts.

### Readers

A new module, `server/src/eventLog.ts`, gives every reader the same view: segments in order, then the live file, each record once. Its functions: `listSegments`, `readLogLines` (an async stream from a sequence number), `readLogText`, `readLogTail`, and for the synchronous readers `readLogTailSync` and `readLogHeadSync`.

| Reader | File and function | Change |
| --- | --- | --- |
| Sequence recovery | `workflowStore.ts` `readLatestSeq` | Falls back to the newest segment name. |
| First sequence (gap fallback) | `workflowStore.ts` `readFirstSeq` | Oldest segment name; else the live file's first record. |
| Full replay | `workflowStore.ts` `replayEvents`, `replayEventsWithTs` | `readLogLines`. |
| HISTORY pages | `workflowStore.ts` `readEventsPageBefore` | `readLogLines`. |
| Tail replay | `workflowStore.ts` `replayTailEvents` | `readLogTail`: the live tail, plus the newest segments when the live file is shorter than the limit. |
| Typed scan | `workflowStore.ts` `scanEventsOfTypes` | `readLogLines` with the same text filter. |
| Resume and REWIND | `resumeSummary.ts` `replayMessagesWithResumePolicy` | The whole history (`readLogText`) when segments exist, as one byte-addressed text; the plain-log path is unchanged. |
| Saved cluster save | `clusterSnapshots.ts` `saveSnapshot` | `readLogText`. The snapshot stays one plain log per member; the 512 MiB cap applies to the uncompressed text. |
| Saved cluster restore | `clusterSnapshots.ts` `restoreSnapshot` | No change: it writes a new plain log. |
| CATCH ME UP | `catchUp.ts` `readCatchUpEvents` | `readLogTail`. |
| Resume picker | `workflows/sessionIndex.ts` `scanOperatorMessages` | `readLogLines`. |
| Session titles | `workflows/sessionDiscovery.ts` `readFirstUserText` | `readLogHeadSync`. |
| Recall | `recall/index.ts` `scanEvents` | `readLogLines`. |
| Hub link | `management/initHubLink.ts` `readLastMessage`, `readFullTranscript` | `readLogTailSync`. |
| Cluster activity | `management/clusterActivity.ts` `readMemberActivity` | `readLogTailSync`. |
| Outputs | `outputs.ts` `reconcile` | Its byte offset into `events.jsonl` becomes a sequence cursor, because sealing replaces the live file. |
| Usage | `http/usageStatsRoutes.ts` `collectWorkflowUsage` | `readLogLines`. |
| Storage report | `storageReport.ts` | Already counts segments by type. |
| Genesis move | `ws/genesisHandlers.ts` `moveWorkflowStoreDir` | No change: it moves the whole folder. |
| Delete | `http/workflowDataRoutes.ts` `purgeWorkflow` | No change: it removes the whole folder. |
| Diagnostics | `diagnostics/checks.ts` `checkEventsLogRoundTrip` | No change: it uses its own temporary log. |

The callers of the `workflowStore.ts` readers need no change: `handoffHandlers.ts`, `turnEngine.ts`, `workflowHandlers.ts`, `clusterHandlers.ts`, `knowledgeHandlers.ts`, `taskLedger.ts` (`rebuildFromEvents`), `voice/computerContext.ts`, `voice/conditionContext.ts`, `voice/conditionReply.ts`, `peerRecipientContext.ts`, `recall/summarize.ts` and Claude Native's `worker.ts`.

A segment that cannot be read is reported and skipped; the reader continues with the next one and the history shows a gap. Nothing is deleted or rewritten.

### Downgrade and export

- `log-format.json` lets releases from 0.1.4 on recognize a newer format and refuse to write to it.
- `arco storage unseal` (and `npm run storage:unseal` in a source checkout) writes every sealed conversation back to one plain `events.jsonl`: all segments, then the live records, checked for order and count before it replaces the live file. Only then are the segments and the marker removed. It refuses to run while Arco is running.

### Compatibility tests for P7.3

| Log shape | Tests |
| --- | --- |
| Plain log only (every log today) | Every reader above returns the same result as before. |
| Segments and a live file | Full replay, HISTORY pages, typed scan, resume and REWIND across a segment boundary, gap fallback, tail replay, CATCH ME UP, usage, recall, resume picker, session titles, hub link, cluster activity, outputs, ledger rebuild, saved cluster save and restore. |
| Live file holding only the copied record | Sequence recovery, reconnect, the next append continues the sequence. |
| Interrupted seal (each row of the crash table) | No record lost or seen twice; the next seal finishes the job. |
| A record larger than 1 MiB at the end | Sequence recovery and tail replay. |
| Several segments, including a long plain log sealed in one go | Order and sequence continuity; reading streams one segment at a time. |
| An unreadable segment | Reported, skipped, the rest readable, nothing deleted. |
| Concurrent appends during a seal | All records present, in order. |
| `arco storage unseal` | Produces one plain log equal to the full history; a plain-log reader (the 0.1.3 behavior) then sees everything. |
| Downgrade without export | The plain-log reader sees the live part and continues the sequence without duplicates. |
| Plans | Sealing, archive and delete never touch `plans/` or `plans/.history/`. |

## P7.4 and P7.5: who builds what

| Part | Builder |
| --- | --- |
| All-projects report endpoint (`/api/storage-report?scope=all`, cached, bounded) | Builder Heavy |
| Size warnings at artifact write time (event and notice data), thresholds, approval sets KEEP | Builder Heavy (server), Builder 1 (notice and approval control) |
| Per-conversation `scratch/`, **EMPTY SCRATCH** endpoint, agent guidance text | Builder Heavy |
| **ARCHIVE**, restore and **DELETE** endpoints, the off-by-default auto-archive rule, disk-budget notice data | Builder Heavy |
| KEEP marks and **MOVE TO PROJECT** | Builder 1 |
| **STORAGE** view in the ARTIFACTS window (rows, expand, buttons calling the endpoints) | Builder 1 |

### KEEP file format

One file per conversation, `<project>/.arco/workflows/<id>/keep.json`, written through a temporary file and a rename:

```json
{ "version": 1, "items": [ { "path": "artifacts/disk.qcow2", "reason": "operator", "at": 1700000000000 } ] }
```

- `path` is relative to the conversation folder, uses `/`, and never contains `..`. `"."` keeps the whole conversation.
- `reason` is `operator` (the KEEP button) or `size-warning` (an approved warning).
- A kept path also covers everything below it.
- Archive, delete, **EMPTY SCRATCH** and size warnings all read this file and skip kept items. A missing or unreadable file means nothing is kept, and archive and delete then stop and ask instead of acting.

## Limits of these numbers

- They are one point-in-time scan of the folders found on one machine. Files can change during a scan.
- Logical sizes can exceed the space used on disk (sparse disk images) or fall below it (small files).
- Git objects shared with a project's own history cannot be assigned to single conversations.
- Compression ratios come from a sample of real logs; they are not guarantees.

## Related

- [Persistence](PERSISTENCE.md)
- [Operations](OPERATIONS.md)
- [HTTP API](HTTP_API.md)
- [Client](CLIENT.md)
