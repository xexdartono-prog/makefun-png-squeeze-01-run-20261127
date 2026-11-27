# Squeeze — lossless PNG recompression

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/xexdartono-prog/makefun-png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/xexdartono-prog/makefun-png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for the make.fun bounty: https://make.fun/bounty/png-squeeze-01-run-20261127

A Node 22 program (stdlib only) that rewrites each 1280×720 screenshot as the
smallest lossless PNG it can: palette / grey / RGB / RGBA / RGB+tRNS colour
reductions, per-row adaptive filters (MSAD and entropy heuristics) plus fixed
filters, zlib level 9 — a fixed deterministic candidate set, smallest file wins.

Run: `node main.ts` (reads `/input/<id>/image.png`, writes `/output/<id>/image.png`).

make.fun referral: 6k6wxasr
