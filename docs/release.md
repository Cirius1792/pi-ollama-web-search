# Release instructions

This package is published to npm as `@cltec/pi-ollama-web-search` and can then be installed by pi with:

```bash
pi install npm:@cltec/pi-ollama-web-search
```

## One-time first publish

Trusted Publishing cannot create a package that does not exist yet on npm. The first version must be published manually from a local machine authenticated with npm.

1. Make sure the repository is clean and all changes are committed:

   ```bash
   git status --short
   ```

2. Log in to npm:

   ```bash
   npm login
   ```

3. Run the release checks:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm pack --dry-run
   ```

4. Publish the first version:

   ```bash
   npm publish --access public
   ```

5. Verify the package page exists:

   ```text
   https://www.npmjs.com/package/@cltec/pi-ollama-web-search
   ```

## Configure npm Trusted Publishing

After the first manual publish, configure npm so future releases are published by GitHub Actions without an npm token.

1. Open the package access/settings page on npm:

   ```text
   https://www.npmjs.com/package/@cltec/pi-ollama-web-search/access
   ```

2. Add a GitHub Actions Trusted Publisher with these values:

   - Owner/user: `Cirius1792`
   - Repository: `pi-ollama-web-search`
   - Workflow filename: `publish.yml`
   - Environment: `npm`

   The workflow filename and environment are case-sensitive and must match `.github/workflows/publish.yml`.

3. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to the repository secrets for this workflow. OIDC authentication is automatic during `npm publish`.

4. Optional but recommended: after verifying one OIDC publish works, set npm publishing access to require two-factor authentication and disallow token-based publishing.

## Normal release flow

Use this flow for every release after Trusted Publishing is configured.

1. Ensure local checks pass:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm pack --dry-run
   ```

2. Bump the package version and create a git tag:

   ```bash
   npm version patch
   ```

   Use `minor` or `major` instead of `patch` when appropriate.

3. Push the commit and tag:

   ```bash
   git push --follow-tags
   ```

4. Create and publish a GitHub Release for the new tag.

5. GitHub Actions will run `.github/workflows/publish.yml` and publish to npm using Trusted Publishing.

6. Verify the package version on npm:

   ```bash
   npm view @cltec/pi-ollama-web-search version
   ```

## Troubleshooting

### `ENEEDAUTH` or authentication failure in GitHub Actions

Check that:

- npm Trusted Publisher is configured for this exact repository.
- The workflow filename is exactly `publish.yml`.
- The Trusted Publisher environment is exactly `npm`.
- The workflow has `permissions.id-token: write`.
- The publish step does not set `NODE_AUTH_TOKEN`.

### Repository/provenance validation error

The package metadata must point at this GitHub repository. Keep this field in `package.json` in sync with the real repository:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/Cirius1792/pi-ollama-web-search"
}
```

### Package contents look wrong

Run:

```bash
npm pack --dry-run
```

The package should include `package.json`, `README.md`, and files under `src/`. Tests, `.github/`, and development-only files should not be included in the published tarball.
