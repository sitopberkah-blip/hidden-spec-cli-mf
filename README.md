# mend

![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sitopberkah-blip/hidden-spec-cli-mf/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sitopberkah-blip/hidden-spec-cli-mf/reward.svg)

mend is a command-line tool that applies the edits AI models write to a tree of text files. Models write edits in
four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format and
text-editor tool calls as JSON — and mend reads all four to one written specification, [SPEC.md](SPEC.md): it finds
the lines an edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, then
indentation-insensitive with re-indentation of the replacement), and it changes every file or none.

This repository is an entry in the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/c/hidden-spec-cli-01-run-20261122).

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. It
  implements all of SPEC.md: the command line and exit codes, format detection, the three matching tiers, unified
  diffs (creations, deletions, moves and hunks chosen nearest the stated line), SEARCH/REPLACE blocks, V4A patches
  (anchors, cursors, end-of-file chunks, moves) and JSON edits, with the all-or-nothing write and the `A` / `D` /
  `M` / `R` report. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts`
  on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: runs the public practice set on your own machine:

      node check.ts <practice.json>

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification mend is built to.
- `LICENSE`: MIT.

## A check

A check is one run of the CLI: its arguments, its standard input (or none) and the files it starts with. It passes
when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says.
Standard error is never compared. Each run has 10 seconds.
