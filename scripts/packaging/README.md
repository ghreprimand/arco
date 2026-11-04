# Release package assembly

Run `npm ci --include=dev` and `npm run build` from the tagged source checkout using Node 24 or 26. Collect the six Node-API native artifacts with `node scripts/packaging/collect-native.mjs <native-artifacts-directory>` on matching Linux, macOS and Windows x64 and arm64 hosts, then combine their output directories without changing their contents. Probe the same artifacts on both Node 24 and 26 with `node scripts/packaging/probe-native.mjs <artifact-directory>`. Use the release workflow artifacts when available.

```sh
npm run release:pack -- <native-artifacts-directory> <output.tgz>
```

This runs the same assembly, npm pack and package audit as the tag workflow. Inspect the tarball, then perform the one-time first manual publication:

```sh
npm publish <output.tgz>
```

Subsequent tag runs stage this same package through trusted publishing and require approval on npmjs.com.
