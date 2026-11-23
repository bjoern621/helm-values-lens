# Changelog

## Unreleased

### Changed

- One entry of the release picker covers an Application and the Applications that its chart renders (listed each apart).
- The release picker shows the entry that the hints follow on top, marked "current".

## v1.10.1 (2026-11-23)

### Removed

- The "Rendered in" line of the hover, which matched the value as text in the manifests and named resources that never read the key.

## v1.10.0 (2026-11-23)

### Added

- The extension comes from the VS Code Marketplace, with an icon of its own.
- Next to each key of a values file, a hint names the layer that overrides it and the value that the release ends up with.
- Next to each `.Values` read in a chart template, a hint shows the final value.
- The hover over a key or a read lists every layer of each release that reads the file, lowest first, each linked to its line.
- A warning marks a key that no chart reads, with a quick fix that renames it to the key a typo away.
- An error marks a value that the chart's `values.schema.json` rejects.
- Suggestions while you type a key or a value come from the chart defaults, its templates and its schema.
- `F12`, `Shift+F12` and `F2` jump to, list and rename a key across values files and templates.
- The layer order comes from Argo CD Applications and ApplicationSets, Helmfile, Flux HelmReleases and Kustomize.

### Changed

- The code lens above a release counts every values layer, the chart defaults included, and names the chart in its link.

### Fixed

- A hint, a hover or a log line names one key, item, resource or release in the singular, such as "{1 key}" (showed "{1 keys}").
- The hover over a key that one other release reads says "1 other release reads this file" (showed "read").
- `Reload Releases` reads a chart's `values.schema.json` and `values.yaml` again after an edit outside VS Code.
