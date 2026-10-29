# Workspace Outputs

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
text documents use the existing text viewer/editor. PDF, office documents and
unknown binaries offer file information and **Download**. HTML, scripts and
unknown files are never executed as previews. Media playback remains an explicit
viewer action. Opens retain the producing workflow and working folder even when
another tab was active.

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
