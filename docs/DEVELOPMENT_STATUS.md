# Development status

This page describes remaining work by plan phase. It contains no commit hashes or host-specific acceptance records.

## Import maintenance

- P1.5: synchronization with upstream changes since the pinned import remains open. Each change must be renamed, scrubbed, verified, and committed separately before advancing the pin.

## Onboarding

- P3.1: the welcome wizard is not implemented. The manual first-chat path is in [Getting started](GETTING_STARTED.md).
- P3.2: guided Connections setup, prerequisite checks, and recovery remain open. Existing provider authentication controls are documented in [Providers](PROVIDERS.md).
- P3.3: stable project identity, pins, archive, and relocation recovery remain open. A workflow can currently use an arbitrary folder path.
- P3.4: task-organized settings and the control-location map remain open.
- P3.5: in-app guided voice status, installation, microphone test, and notices remain open. The command-line setup is described in [Voice](VOICE.md).

## Portability

- P2.1: Docker baseline and persistent home/project mounts are available. Fresh-install acceptance remains open.
- P2.2 and P2.4: native acceptance is not complete across Linux, macOS, and Windows. Mac and Windows checks require their target hosts.
- P2.3: voice setup and model downloads are available; target-host acceptance remains separate from the setup implementation.

## Documentation and release

- P4.1: reference docs and the new-user walkthrough are being completed. The [documentation index](INDEX.md) lists maintained guides.
- P4.2: third-party notices for bundled assets and voice setup components remain open.
- P5.1: hosted CI coverage on Linux, macOS, and Windows remains open.
- P5.2: fresh-install acceptance from the README, native and Docker, remains open.
- P5.3: the operator's daily-driver trial remains open.
- P5.4: final content/history and license review, followed by the operator's release decision, remains open.
