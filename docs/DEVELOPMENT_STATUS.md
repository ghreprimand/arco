# Development status

Hosted CI runs automated checks on Linux, macOS, and Windows.

## Import maintenance

Imported changes are renamed, scrubbed, verified, and committed separately.

## Onboarding

The welcome flow, provider Connections setup, Home, task-organized settings,
guided voice setup, file and media access controls, the utility agent, and
package install with per-user services are implemented. The
[Getting started guide](GETTING_STARTED.md), [Providers](PROVIDERS.md),
[Settings](SETTINGS.md), [Voice](VOICE.md), and [Security](../SECURITY.md)
describe the user paths.

## Portability

Arco supports native installation and Docker. Voice setup downloads speech
components on request. Packaged installs expose `arco update` and **UPDATE AND
RESTART** on Linux, macOS, and Windows.

## Documentation and release

The reference documentation, in-app manual, third-party notices, and public
reader guides are published with the package. Strata and DeepSeek through
Xolotl are optional external-service integrations; Arco does not distribute
those services. Contributor recipes are in [Extending Arco](EXTENDING.md), and
debugging and hot-reload guidance is in [Diagnostics](DIAGNOSTICS.md).

Installation, service, voice, Docker, and update instructions are included in the guides.
