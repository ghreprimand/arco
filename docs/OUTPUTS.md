# Workspace Outputs

Browse generated artifacts and exports for a workflow or cluster, then
preview, copy or move them within approved folders.

Open **Workspace > Files > Outputs** in a workflow or cluster. Outputs stays
available after a generated-file preview is dismissed. **View in Outputs** on an
artifact preview opens the producing workflow's collection. A cluster combines
its members' outputs and identifies the producer; unrelated workflows in the same
project are excluded. Incognito and voice-operator workflows are excluded.

Search by title, filename, producer or location. Filter **All**, **Images**,
**Documents**, **Audio**, **Video** or **Other**. Entries appear newest first and
show their producing workflow, creation/update time, current location and file
information. Refresh updates the list without generating content. Missing files
retain their original provenance.

By default the list shows only what was made for you: generated images, audio
and video, documents at the top level of the artifacts folder, and reports and
exports. Code files and anything inside an artifact subfolder are working files,
shown when **All files** is ticked; a note under the filters says how many are
hidden. The server marks each entry with `primary` (`isPrimaryOutput` in
`server/src/outputs.ts`); the toggle is per view and resets when the panel reopens.

## Discovery and persistence

The collection joins files in each workflow's `artifacts` directory with durable
path-backed artifact events, supported completed Write/Edit/NotebookEdit events,
and scoped editor/media exports. Generated images saved in the project working
folder are included. Raw-tool recovery spills, hidden files, credentials, runtime
state and other workflows' artifact stores are excluded. The modal queue and the
currently active tab are not the inventory.

Per-workflow `outputs.json`, beside the workflow's event log, retains discovered
locations, original locations, copy/move records and derived-output links.
`events.jsonl` remains the durable event source. Replayed events and repeated scans
are deduplicated. A reconnect or restart can rebuild entries from those events
and artifact files. Listing reconciles at most 32 MiB of new event history per
refresh; artifact enumeration stops at depth eight and 2,000 entries per workflow.
Cluster responses show the newest 2,000 entries. Inline content is fetched only
when opened. The metadata file is bounded to 8 MiB. A damaged index is reported and left intact.

Ordinary changed project files are not classified as generated. Unsupported
provider write-tool forms may require saving the result into the workflow's
artifacts directory. Older stem events that recorded only a directory cannot
identify all exported filenames; new stem events record the exact file paths.
Inline text/code artifacts remain inline until **Save a copy** explicitly exports
a file. Nothing invents a disk file for an inline artifact.

## Preview, edit and save

Images, audio and video use the existing media viewers and editors. Supported
text documents use the existing text viewer/editor. Clicking an entry's name (or
its image) opens the preview when one exists. PDF, office documents and other
types without a preview open in the computer's default app instead, and every
file-backed entry also has **OPEN** and **Download**. HTML, scripts and
unknown files are never executed as previews. Media playback remains an explicit
viewer action. Opens retain the producing workflow and working folder even when
another tab was active.

**OPEN** works only on the computer Arco runs on: the server resolves the
registered output (never a path from the page), checks the file exists and hands
it to the system opener (`xdg-open`, `open`, or the Windows shell handler with
the path as one argument). Programs and scripts (for example `.exe`, `.bat`,
`.ps1`, `.sh`, `.js`, `.jar`, `.lnk`, `.app`, `.desktop`) and files with no
extension are refused with a message; **Download** stays available. In Docker or
on a machine without a desktop, OPEN is hidden.

Editor saves and exported variants appear under their producing workflow. A
variant derived from a tracked output retains its origin association. Existing
editor overwrite confirmations and media-operation requirements remain in force;
a collection entry does not install FFmpeg or a model.

**Save a copy** opens the shared directory picker with a filename. Review the
source and destination, then choose **Save copy**. The original remains available.
**Move** is a separate action for disk files: review both locations, then confirm
**Move output**. Existing files are never silently overwritten. A stale dialog
must be refreshed if another action already moved the output.

Copy/move destinations must be inside an existing approved project or enabled
media folder. Browsing another directory does not grant content or write access.
Protected state and symlink escapes remain refused. A move saves the destination
and durable location mapping before removing the source; destination or metadata
failure leaves the source intact. Existing indexed and artifact-path links resolve
to the moved location. Removing an external file produces a missing-file state;
Outputs does not offer destructive cleanup.

**MOVE TO PROJECT** on an artifact offers **KEEP IT PRIVATE** or **ADD TO
PROJECT FILES**. Before a copy, review the destination, Git ignore and public
repository status, size and content findings. Files not fully scanned are listed
by name: binary files other than images and recordings, where only runs of
readable text are scanned, and files past the findings limit (1,000 findings per
file, 2,000 per copy; the rest of the file is hashed but not scanned). Copying them into a public repository outside Git ignore requires a
second confirmation. Projects opened through a linked parent folder are supported;
links within the artifact remain refused. The original stays in the artifact
store; Arco does not stage or commit the copy. A large-artifact warning offers
**KEEP** to protect the artifact from cleanup or **DISMISS**.

A kept artifact shows **Kept** with **UNKEEP** beside it (the listing carries
`keptBy`, the KEEP mark that covers the file). UNKEEP asks first and removes that
mark: the file's own, a kept folder above it, or the one on the whole
conversation. No file is changed.

## Related links

- [Feature reference](FEATURES.md)
- [Media studio](MEDIA_STUDIO.md)
- [Documentation style](STYLE.md)
