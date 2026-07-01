# Release checklist

## One-time setup

- [ ] Register the publisher / confirm `PublisherId` in `pyproject.toml` `[tool.comfy]`.
- [ ] Add the repo to `gitops/repositories.tf` with `comfy_registry = true` and
      `release_please = true` (do not configure via the GitHub UI). On the Scalr
      apply, gitops pushes `REGISTRY_ACCESS_TOKEN`, `RELEASE_PLEASE_APP_ID` (var),
      and `RELEASE_PLEASE_PRIVATE_KEY` (secret) automatically — no manual secret
      creation. The `/comfy-node` orchestrator does this wiring for you.
- [ ] Verify the secrets landed: `gh secret list -R laurigates/<name>`.

## Per release

- [ ] Land work via conventional commits on feature branches → PRs to `main`.
- [ ] Merge the release-please PR (it bumps `version` + updates `CHANGELOG.md`).
- [ ] Publishing the GitHub release (release-please does this on merge)
      triggers `publish.yml`, which runs `bun install && bun run build` before
      `publish-node-action` so the built `web/dist/` exists at publish time →
      Comfy Registry. A follow-up step sets the registry version changelog
      ("Updates" section) from the release notes.
- [ ] Verify the new version appears on registry.comfy.org.
