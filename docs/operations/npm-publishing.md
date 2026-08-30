# npm publishing

`paseo-agy-acp` releases have two distinct outputs:

1. a GitHub tag and GitHub Release;
2. the matching public npm package.

Pushing a three-part semver tag such as `v2.3.0` starts
[`.github/workflows/publish-npm.yml`](../../.github/workflows/publish-npm.yml).
The workflow publishes automatically; maintainers do not dispatch it manually.

## One-time trusted publisher setup

The package uses npm Trusted Publishing. It does not use a long-lived
`NPM_TOKEN` GitHub secret.

The npm package owner must configure this relationship once with npm CLI
11.15.0 or newer:

```bash
npm login
npm trust github paseo-agy-acp \
  --repo tiezbro/paseo-agy-acp \
  --file publish-npm.yml \
  --env npm \
  --allow-publish
```

The trusted publisher fields are case-sensitive. The workflow value is the
filename only (`publish-npm.yml`), not its `.github/workflows/` path. The npm
trusted publisher environment must exactly match the GitHub environment name
`npm`.

Trusted Publishing authenticates `npm publish` through GitHub OIDC. It does not
authenticate `npm whoami`, `npm install`, or package-management commands.

## Stable release

Prepare and merge the release commit before creating the tag:

1. Set the same three-part version in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md`, README version pins, tests, and release smoke checks.
3. Run `npm run validate` and inspect `npm pack --dry-run --json`.
4. Push the release commit to `main` and wait for CI.
5. Create and push the matching tag, for example `v2.3.0`.
6. Create the GitHub Release for that tag.

The tag push automatically runs the npm workflow. That workflow:

- rejects non-three-part tags;
- requires the tag to match `package.json` exactly;
- requires the tagged commit to be contained in `main`;
- installs dependencies and runs the complete validation suite;
- builds one npm tarball and rejects packaged `.par`, database, or SQLite files;
- uploads the tarball and its content manifest as a 30-day Actions artifact;
- publishes that exact tarball with public access and npm provenance.

Monitor and verify the automatic publish:

```bash
gh run list --workflow publish-npm.yml --limit 5
gh run watch RUN_ID --exit-status
npm view paseo-agy-acp version dist-tags --json
```

npm versions are immutable. Never move a published version tag or retry with
different content under the same version. If the workflow fails before
`npm publish`, fix the release automation and rerun the failed tag workflow. If
npm already contains the version, verify its provenance and tarball instead of
publishing again.
