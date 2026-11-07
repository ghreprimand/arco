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

The storage report (in a single-worker, chat or cluster tab, **MEMORY > USAGE** in the right panel: **MEASURE STORAGE** and **MEASURE ARCO FOLDER**; from anywhere, ARTIFACTS > STORAGE with **MEASURE AGAIN**) walks a state folder in a background worker and puts every file into exactly one bucket. Rules:

- Sizes are logical file sizes. The allocated size on disk is reported beside them.
- A file with several hard links is counted once. The extra links are reported separately.
- A project state folder inside another state folder (chat and Genesis projects inside Arco's own folder) is skipped there and measured as its own project.
- Links to other places are never followed. Nothing is written.

Two state-folder samples were measured read-only. The first was a small installation. The second was a large, long-used installation with the same folder layout, written by an earlier version of Arco. The figures below are rounded and describe storage patterns relevant to the recommendations.

### Totals

| | Small installation | Large, long-used installation |
| --- | --- | --- |
| Project state folders | about 50 | about 140 |
| Project state, logical | about 5 MB | about 120 GB |
| Extra hard links (not counted again) | 0 | about 8 GB |
| Arco's own folder | about 2 GB | about 60 GB |
| Nested project state folders skipped in Arco's own folder | 1 | about 30 |

The earlier report counted hard links twice and counted the chat projects inside Arco's own folder twice. The figures above remove both.

### Project state by bucket (large installation)

| Bucket | Bytes | Share |
| --- | --- | --- |
| Worktrees and isolated copies | about 60 GB | about 50% |
| Artifacts | about 45 GB | about 40% |
| Conversation logs | about 8 GB | about 7% |
| Other files | about 2 GB | about 2% |
| Scratch files and other conversation data | under 1 GB | under 1% each |
| Task boards and plans | under 1 GB each | under 1% each |

### The largest project (large installation)

| Bucket | Bytes |
| --- | --- |
| Worktrees and isolated copies | about 60 GB |
| Artifacts | about 35 GB |
| Conversation logs | about 5 GB |
| Other | about 2 GB |
| Total | about 100 GB |

The previously unexplained storage was mostly worktrees inside project state folders, along with other files and hard links counted more than once. The largest project has no nested state folder.

### Arco's own folder

| Bucket | Small installation | Large, long-used installation |
| --- | --- | --- |
| Caches and browser profiles | about 0.3 GB | about 30 GB |
| Voice and media models | about 1 GB | about 20 GB |
| Provider account data | 0 | about 10 GB |
| Checkpoints | about 0.03 GB | about 1 GB |
| Saved clusters | under 0.1 GB | under 1 GB |
| Server logs and other | under 0.1 GB | under 1 GB each |

### Conversation logs (large installation)

- About 1,900 logs were measured. Board snapshots made up about half of the log bytes; tool calls made up about a quarter. This supports removing repeated snapshots while retaining the individual task changes.
- Some logs exceeded 30 MiB, and the largest was several hundred MiB. This supports lossless rotation and compression without relying on a single log size.

### Artifacts (large installation)

- About one third of conversations had artifacts. A small number of files reached hundreds of MiB or more, supporting per-file and per-conversation warnings.

### Compression of logs

Measured on real logs with Node's built-in `zlib`, without writing anything:

| Sample | Uncompressed | gzip | Brotli (quality 5, 16 MiB window) |
| --- | --- | --- | --- |
| About a dozen logs, a few to several dozen MB each | about 80 MB | about 4x smaller | about 14x smaller |
| A log over 100 MB without board copies | about 120 MB | about 4x | about 150x |
| A large board-copy log | about 460 MB | about 3x | over 3,000x |

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
- **Effect:** about half of the log bytes in the large, long-used installation.

### 2. Plan bodies in logs (P7.2)

- **Recommendation:** store each distinct plan body once in a plan history folder, `<project>/.arco/plans/.history/<sha256>.md`, and log only its hash and length. The history folder sits inside the plans folder, so it is permanent like the plans.
- **Trade-off:** reading an old plan version needs the history file, not just the log. The saving is small (under 1%); the main gain is that a long plan is not copied into every member's log on every tick.

### 3. Streamed text

- **Recommendation:** leave streamed text as it is. Sealed segments compress it.
- **Trade-off:** the live file is larger until it is sealed.

### 4. Log segments (P7.3, approved)

- **Recommendation:** seal the live log when it passes 16 MiB into compressed segments of at most 16 MiB of records each, using Brotli from `node:zlib` (quality 5, 16 MiB window). This differs from the earlier gzip suggestion: Brotli is equally built in and is 3 to 1,000 times more effective on these logs, and faster on the large ones.
- **Trade-off:** fewer outside tools read Brotli than gzip. The export command below turns any log back into one plain file.

- **Closed conversations:** a log is sealed when it is written to, so closed conversations keep their plain logs until the operator clicks **COMPRESS OLD LOGS** on the STORAGE page. It seals the closed conversations of one project and skips open or working ones; there is no background sweep.

### 5. Downgrade (P7.3)

- **Recommendation:** releases from 0.1.4 on write a format marker in each sealed conversation and refuse to write to a log with a newer format than they know. Releases before 0.1.4 cannot refuse; for them, `arco storage unseal` exports every sealed log back into one plain `events.jsonl` before a downgrade.
- **Trade-off:** a downgrade without the export shows only the unsealed part of each history. It does not corrupt anything: the newest record stays in the live file, so sequence numbers continue correctly. Upgrading again shows the full history.

### 6. Artifact warnings and scratch (P7.4, approved with conditions)

- **Recommendation:** warn at write time when one artifact file reaches 1 GiB, or a conversation's artifacts reach 5 GiB. These thresholds would have warned on a small number of files and conversations in the large, long-used installation. Approving a warning sets **KEEP** on that file or folder, and it never warns again.
- **Scratch:** each conversation gets `scratch/` beside `artifacts/`, not inside it. Agent guidance says to put large intermediate files there. **EMPTY SCRATCH** deletes it, only on the operator's click and after a confirmation. Kept items are skipped.
- **Trade-off:** files under the thresholds never warn, even when many of them add up. The per-conversation total covers most of that.
- **Checked when:** every 30 seconds while a turn runs and again when it ends (`server/src/storageTurnWatch.ts`); each item still warns once. `ARCO_ARTIFACT_WARN_FILE_BYTES` and `ARCO_ARTIFACT_WARN_CONVERSATION_BYTES` override the thresholds and `ARCO_ARTIFACT_WARN_INTERVAL_MS` the interval.

### 7. Archive, delete and the disk-budget notice (P7.5, approved)

- **Recommendation:** **ARCHIVE** packs a closed conversation folder into one compressed file, `<project>/.arco/archive/<id>.arcoarchive`, and can be restored; **DELETE** removes it after a confirmation. Both are operator clicks. The optional auto-archive rule ("closed more than 30 days") is off by default and never deletes. A disk-budget notice appears when all state folders and Arco's own folder together pass 100 GiB; the number is adjustable and the notice can be turned off.
- **How:** the archive holds each file with its SHA-256 and is read back against them before any file is removed; kept items and links stay in the conversation folder. Restore checks the whole archive first and never overwrites a file. Delete uses the existing purge and leaves kept items. The rule and the notice live in Arco's `storage-policy.json`; a daily run applies the rule and measures again for the notice.
- **Trade-off:** archiving keeps the bytes of artifacts that are already compressed (disk images, archives), so it frees little for them. Delete is the only way to reclaim those, and it stays a confirmed click.

### 8. One storage page for all projects (approved)

- **Recommendation:** yes. The **STORAGE** view in the ARTIFACTS window lists every known project, largest first, with logs, artifacts, scratch, worktrees and the biggest item, and Arco's own folder as its own row. It reads the same report as USAGE.

### 9. Worktrees and caches (new, needs a decision)

- **Finding:** in the large, long-used installation, the largest project-state bucket was worktrees and isolated copies (about 60 GB). Arco's own folder held tens of gigabytes of caches and voice environments.
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
2. Skip a record only when an existing segment's name covers its sequence number and that segment passes the content check: it decompresses, every line parses, sequence numbers rise, and the first and last match the name (left over from an interrupted seal, or the copied record). A segment that fails is renamed `<name>.damaged-<time>`, kept on disk and no longer read; its records are sealed again from the live file.
3. Write the other records into segments of at most 16 MiB of records each, never spanning an existing segment: compress into a `.tmp` file, flush it to disk, read it back and compare, then rename it to its final name and flush the folder.
4. Write `log-format.json` if it is missing.
5. Replace the live file with a new one that holds only the newest sealed record, through a temporary file and a rename.

The copied last record keeps sequence numbers continuous for a release that reads only `events.jsonl`. New readers skip a live record only up to the newest sequence number they read from a segment, or that a checked segment holds, so it is never seen twice and a damaged segment never hides live records.

### Crash safety

| Interrupted | On disk | Result |
| --- | --- | --- |
| Before a segment's rename | A `.tmp` file and the full live file | Readers ignore the `.tmp`; the next seal removes it and starts again. A segment that failed its read-back is never renamed into place. |
| After some segments, before the live file is replaced | Segments and the full live file | Readers skip the live records already read from a segment; the next seal checks those segments and continues after them. |
| A segment whose content does not match its name (disk damage, or a release before this check) | That segment and the full live file | The next seal moves the segment aside and seals its records again from the live file. |
| During the live file replacement | The old or the new live file, never half of one | Both are valid. |
| Live file replacement refused (Windows, a reader holds it open) | Segments and the full live file; the temporary file removed | Reported; readers skip what is sealed; the next seal replaces the live file. |

Sequence numbers come from `readLatestSeq`, which reads the live file's tail, and from the highest `lastSeq` in any segment name, including segments moved aside as damaged. They stay monotonic across seals, crashes, restarts and damaged segments.

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

- They are one point-in-time scan of the folders found in each sample. Files can change during a scan.
- Logical sizes can exceed the space used on disk (sparse disk images) or fall below it (small files).
- Git objects shared with a project's own history cannot be assigned to single conversations.
- Compression ratios come from a sample of real logs; they are not guarantees.

## Related

- [Persistence](PERSISTENCE.md)
- [Operations](OPERATIONS.md)
- [HTTP API](HTTP_API.md)
- [Client](CLIENT.md)
