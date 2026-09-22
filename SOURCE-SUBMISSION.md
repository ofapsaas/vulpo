# Source submission notes (for AMO reviewers)

Add-on: **Vulpo MCP — Browser Bridge** (`vulpo@pablorizzo.com`, v0.5.2)
Repository: <https://github.com/ofapsaas/vulpo> (this archive is the exact
source tree of the submitted version — additional context only; this package
is the authoritative source for review).

## Build environment

- OS: Debian GNU/Linux 13, x86_64 (**differs from the reviewer default**
  Ubuntu 24.04 ARM64 — the build is pure userland and OS-agnostic).
- Node.js: **v24.21.0** (npm 11.x). Reviewer default (Node 24.14.0 / npm 11.9.0)
  should also work; the build only needs Node ≥ 22 and the pinned npm deps.

## Build steps (reproduces the submitted XPI byte-for-byte)

```bash
# 1. install pinned build dependencies (esbuild 0.28.2 + dom-accessibility-api 0.7.1)
cd extension/frame && npm ci
cd ../odoo       && npm ci

# 2. build the XPI (regenerates all 4 esbuild bundles + zips the extension)
cd ../.. && bash scripts/build-xpi.sh
# → dist/vulpo-0.5.2.xpi
```

- The four generated files included in the extension — `frame-serializer.js`,
  `session-probe-bundle.js`, `nav-guard-bundle.js`, `odoo-nav-guard-bundle.js`,
  `frame-fold-bundle.js` — are esbuild bundles of the sources in
  `extension/frame/` (entry `index.js` + `dom-accessibility-api 0.7.1`),
  `extension/odoo/session-probe.js`, `extension/nav-guard.js`,
  `extension/odoo/nav-guard.js` and `extension/frame-fold.js`
  (see `extension/frame/build-frame.sh` and `extension/odoo/build-probe.sh`).
- Every other JS file shipped in the XPI **is the source file itself**
  (no minification anywhere).
- The build was verified reproducible: regenerating the bundles from this
  tree produces byte-identical output (`npm ci` pins esbuild 0.28.2 via
  `extension/frame/package-lock.json` and `extension/odoo/package-lock.json`).
- Build output target: the bundles are written next to the sources
  (`extension/*.bundle.js`, `extension/frame-serializer.js`) and then zipped
  by `scripts/build-xpi.sh` into the XPI at the repo `dist/` folder.

## Third-party libraries

| Library                | Version | License | Where it ends up                        |
| ---------------------- | ------- | ------- | --------------------------------------- |
| `esbuild`              | 0.28.2  | MIT     | build-time only (never in the XPI)      |
| `dom-accessibility-api`| 0.7.1   | MIT     | bundled inside `frame-serializer.js`    |

## Source package contents

This archive is the full extension source tree (manifest, all JS sources,
HTML/CSS, build scripts, npm manifests and lockfiles). `dist/`, `logs/`,
`findings/` and `node_modules/` are excluded (build artifacts / dependencies
restored by `npm ci` from the committed lockfiles).
