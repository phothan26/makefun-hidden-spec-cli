# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/phothan26/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/phothan26/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON text-editor tool calls to a tree of text files. Every edit applies whole or fails whole — when any edit fails, no file is written. Old lines are matched at three tiers (exact, trailing whitespace, leading and trailing whitespace), unless `--strict` asks for exact matches only.

## Run it

```sh
node main.ts fix.patch
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH is a path, or `-`/absent for standard input; `--format` is `auto` (the default), `unified`, `search-replace`, `v4a` or `json`; `--check` is a dry run (same output, nothing written); `--strict` matches lines exactly. See SPEC.md for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t7e39kme&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
