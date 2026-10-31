# Development status

Fresh-install acceptance from the README has passed for native Linux and Docker. Three-OS hosted CI is green. The operator's daily-driver trial and macOS and Windows target-host checks remain open before the `v0.1.0` tag.

## Import maintenance

Upstream changes continue to be tracked while Arco is evaluated as the primary workbench. Each imported change is renamed, scrubbed, verified, and committed separately. Upstream imports stop when the operator adopts Arco as the main harness.

## Onboarding

The welcome flow, provider Connections setup, Home, task-organized settings, guided voice setup, and file/media access controls are implemented. The [Getting started guide](GETTING_STARTED.md), [Providers](PROVIDERS.md), [Settings](SETTINGS.md), [Voice](VOICE.md), and [Security](../SECURITY.md) describe the user paths.

## Portability

Docker and native Linux fresh-install acceptance from the README passed. macOS and Windows target-host acceptance remains open and requires the operator's machines. Voice setup and model downloads are available on all three platforms; microphone and speech acceptance on the target hosts remains part of those checks.

## Documentation and release

The reference documentation, in-app manual, third-party notices, and public-reader pass are complete. Strata and DeepSeek through Xolotl are optional external-service integrations; Arco does not distribute those services. Contributor recipes are in [Extending Arco](EXTENDING.md), and debugging and hot-reload guidance is in [Diagnostics](DIAGNOSTICS.md).

The remaining release work is the operator's daily-driver trial, macOS and Windows target-host acceptance, final history/content and license audit, and the operator's approval to tag `v0.1.0`. The repository is already public.
