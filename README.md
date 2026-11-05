# Gaugeline

[![CI](https://github.com/alvinwquach/gaugeline/actions/workflows/ci.yml/badge.svg)](https://github.com/alvinwquach/gaugeline/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-18.17%20%7C%2020%20%7C%2022-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-informational)

Gaugeline checks a website the way search engines and visitors see it, and tells whoever owns
the site what to fix first. It only reads: every request to a checked site is a GET or a HEAD.

> Status: under construction. Nothing is published to npm yet.

## Install

Gaugeline needs Node.js 18.17 or newer. It is tested on Node 18.17, 20 and 22 on Linux, and on
Node 20 on macOS and Windows.

```bash
npx gaugeline example.com
```

## Usage

```bash
npx gaugeline example.com          # check a page
npx gaugeline example.com --ci     # exit 1 on a "Fix this first" finding
npx gaugeline example.com --json   # a versioned JSON result on stdout
```

Run `gaugeline --help` for every option, or see [docs/options.md](docs/options.md).

## Working on Gaugeline

```bash
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how branches and pull requests work, and
[RELEASING.md](RELEASING.md) for how a version is published.
