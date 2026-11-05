# Changesets

Every pull request adds one file here with `pnpm changeset`. It names the package and the bump
(patch, minor or none) and has one sentence a site owner would understand: present tense, no file
names. Internal work uses `pnpm changeset --empty` with a sentence starting "(internal)".

The Release pull request turns these files into `packages/cli/CHANGELOG.md` and a version bump.
