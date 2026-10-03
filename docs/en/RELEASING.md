# Versioning and releases

日本語: [../RELEASING.md](../RELEASING.md)

rproxy-api ([max3584/rproxy-api](https://github.com/max3584/rproxy-api)) and the UI ([max3584/TCP-UDP-rproxy-ui](https://github.com/max3584/TCP-UDP-rproxy-ui)) are **released together with the same version number**.
UI vX.Y.Z is used together with rproxy-api vX.Y.Z. Even when only one of them has changes, tags and releases with the same number are created for both.

## How to bump the version

To avoid bumping the minor version often, **the shapes (interfaces) are decided together in a minor release, and the implementations are made usable step by step in patch releases**.

| Change | Part to bump | Example |
|---|---|---|
| Adding to or changing the shape of the settings file, control API or DB (`options`, etc.) (until 1.0, breaking changes also go here) | Minor | 0.2.x → 0.3.0 |
| Making the implementation of a feature whose shape is already decided usable (announcing availability in `GET /capabilities`) | Patch | 0.3.0 → 0.3.1 |
| Bug fixes, documentation, dependency updates, improvements to packaging and installers, tests | Patch | 0.3.1 → 0.3.2 |

- In a minor release, decide together the settings and API shapes of the features to be added over the coming period, and write them in docs/API.md. Items whose implementation is not ready yet are announced as unavailable in `GET /capabilities` and rejected with `unsupported` when specified.
- If a change cannot be made without changing a shape, gather it into the next minor release.

## Milestones

- Keep open "next patch" (e.g. v0.2.3), "next minor" (e.g. v0.3.0; the work of deciding shapes) and "implementation" (e.g. v0.3.x; the work of making implementations usable).
- When creating PRs and issues, attach the milestone determined by the table above. For PRs where it was forgotten, `.github/workflows/milestone.yml` attaches the milestone of the nearest version (the same for Renovate's PRs).
- When releasing a patch, move the finished items of "implementation" to that patch's milestone (e.g. v0.3.1) and release.
- Verification work that waits on the environment or on an administrator's action (checks on real machines, installing apps, etc.) gets no milestone, so that it does not block releases.
- Release when everything in the milestone is closed. Move unfinished items to the next milestone.

## Release procedure

1. **A PR that bumps the version** (branch `release/vX.Y.Z`, with the same name in both repositories; the UI's e2e tests against the rproxy-api branch of the same name)
   - rproxy-api: `version` in `Cargo.toml`
   - UI: `npm version X.Y.Z --no-git-tag-version` (`package.json` and `package-lock.json`)
2. **Once merged, release the UI first, then rproxy-api** (because rproxy-api's apt publishing takes the `rproxy-ui` .deb from the UI release with the same number) (`vX.Y.Z`. Tags cannot be deleted or moved because of rulesets, so check the commit before tagging)
   - rproxy-api: pushing the tag makes `release.yml` build the binaries and .deb, attach them to the GitHub Release and update the apt repository. It stops if the tag and `version` in `Cargo.toml` differ
   - UI: create the tag and release with `gh release create vX.Y.Z --target <full ID of the merge commit>`. On publishing, `release.yml` builds and attaches `rproxy-ui_X.Y.Z-1_all.deb`, so wait for it to finish
   - rproxy-api: push the tag after the UI .deb above has been attached (if it is missing, the apt job warns and publishes only rproxy-api; to add it later, re-run the apt job)
3. **Release notes**: write the "Main changes" in Japanese from the PRs merged in that milestone, and add a link to the paired release of the other repository
4. **Close the milestone** and create the milestone for the next patch
5. Check that it was published on apt (the new version is visible with `apt-cache policy rproxy-api`)
