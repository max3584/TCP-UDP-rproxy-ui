# Versioning and releases

日本語: [../RELEASING.md](../RELEASING.md)

rproxy-api ([max3584/rproxy-api](https://github.com/max3584/rproxy-api)) and the UI ([max3584/TCP-UDP-rproxy-ui](https://github.com/max3584/TCP-UDP-rproxy-ui)) **share one sequence of version numbers**.
When what runs changes in both, release them together under the same number (UI vX.Y.Z pairs with rproxy-api vX.Y.Z). **When what runs changes in only one of them, release only that one** (the other skips the number; e.g. after a UI-only v0.3.16, rproxy-api's next release is v0.3.17). A release pairs with the newest release of the other at or below its number (UI v0.3.16 pairs with rproxy-api v0.3.15).

## How to bump the version

To avoid bumping the minor version often, **the shapes (interfaces) are decided together in a minor release, and the implementations are made usable step by step in patch releases**.

| Change | Part to bump | Example |
|---|---|---|
| Adding to or changing the shape of the settings file, control API or DB (`options`, etc.) (until 1.0, breaking changes also go here) | Minor | 0.2.x → 0.3.0 |
| Making the implementation of a feature whose shape is already decided usable (announcing availability in `GET /capabilities`) | Patch | 0.3.0 → 0.3.1 |
| Bug fixes, dependency updates (they change what gets built), improvements to packaging and installers | Patch | 0.3.1 → 0.3.2 |
| Changes only to the README, docs, CI or tests | No bump | Ship them with the next release that changes code |

- **Bump the version only when what runs changes** (the rproxy-api binary or source code, the UI code, the package contents). Changes only to the README, docs, badges, CI or tests don't get a release of their own; they stay in the milestone and go out with the next release.
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
   - **UI-only release**: once the UI release has its .deb attached, run rproxy-api's `release.yml` by hand to publish it to apt (`gh workflow run release.yml -R max3584/rproxy-api -f ui_tag=vX.Y.Z`; rproxy-api is not built). Don't open a version bump PR or push a tag in rproxy-api
3. **Release notes**: write the "Main changes" in Japanese from the PRs merged in that milestone, and add a link to the paired release of the other repository (for a one-sided release, link the previous release of the other)
4. **Close the milestone** and create the milestone for the next patch
5. Check that it was published on apt (the new version is visible with `apt-cache policy rproxy-api`)
