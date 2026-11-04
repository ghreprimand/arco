# README captures

After installing Arco dependencies and running `npm run build`, install Python
Playwright in a local virtual environment, install Playwright's Chromium
browser, and install the libwebp tools (`cwebp`). On Linux, the capture requires `unshare` and `ip`, with
unprivileged network namespaces enabled:

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 scripts/screenshots/capture.py
```

The version shown in the captures defaults to the `version` in `package.json`;
pass `--version X.Y.Z` to show a different one.

The script requires a network namespace, creates a temporary home and synthetic
projects, starts the built server on a free loopback port, and serves a fixture
for all browser API and WebSocket data. It stops the server and deletes the
temporary home on exit. No provider or model calls are made. `ARCO_TEST_CHROME`
may select an existing Chromium executable.

Each capture is visually reviewed for private content before its SHA-256 digest
is updated in `scripts/public-audit.mjs`. The audit rejects replacements whose
bytes do not match the reviewed digest. Rendering may vary between systems, so
a regenerated image must be reviewed again before its digest is changed.

Images are captured at a device scale factor of 2 (a 1920x1080 layout saved at
3840x2160) and encoded with `cwebp -q 85 -sharp_yuv -m 6`, which keeps
full-resolution colour for small text and gradients at a few hundred KB each.
