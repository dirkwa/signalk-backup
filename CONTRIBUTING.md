# Contributing

Bug reports, feature requests and pull requests are welcome at
<https://github.com/dirkwa/signalk-backup>.

Before opening a pull request, run the full local chain. It needs Node 22.18 or
later, which runs the TypeScript build scripts directly:

```bash
npm run format && npm run build:all
```

## TypeScript only

All code in this repository is TypeScript with `strict` on: the plugin, the
webapp, tests, build scripts and tool configs. Please don't add JavaScript
files (`.js`, `.mjs`, `.cjs`, `.jsx`); tool settings that are only data belong
in JSON. Fix a type error rather than silencing it with `any`, `@ts-ignore` or
a looser `tsconfig`.

## Keeping your branch up to date

Rebase onto `main` rather than merging `main` into your branch. With
`origin` pointing at your fork and `upstream` at this repository
(`git remote add upstream https://github.com/dirkwa/signalk-backup.git`):

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease --force-if-includes origin HEAD
```

A rebased branch shows reviewers only your changes and keeps history linear.
Merging `main` in instead adds a merge commit, which is not a conventional
commit and carries unrelated changes into your pull request. The two force flags
together refuse to overwrite commits on your branch that you have not seen,
even if a background fetch has already updated your remote-tracking branch
(`--force-if-includes` needs Git 2.30 or later). If a rebase gets stuck on
conflicts, say so in the pull request and we will rebase it for you.

## Contributor license grant

By submitting a pull request or patch, you grant Dirk Wahrheit a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce,
modify, publish, sublicense and distribute your contribution, and to relicense
it under any terms, including as part of signalk-backup releases. You confirm
that you have the right to grant this.
