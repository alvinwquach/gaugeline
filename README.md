# Gaugeline

Gaugeline checks a website the way search engines and visitors see it, and tells whoever owns
the site what to fix first. It only reads: every request to a checked site is a GET or a HEAD.

> Status: under construction. Nothing is published to npm yet.

## Install

Gaugeline needs Node.js 18.17 or newer.

```bash
npx gaugeline example.com
```

## Usage

```
Usage: gaugeline <address> [options]

Options:
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit

Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run
```

## Working on Gaugeline

```bash
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how branches and pull requests work.
