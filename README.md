# Helm Values Lens

Helm Values Lens shows in VS Code where each Helm value gets set, which layer overrides it and the value that the chart renders with.
It reads the order of the values files from the Argo CD Applications in your workspace.
A GitOps repository needs no setup.

## What it shows

- Next to a value in a values file: the layer that overrides or deletes it, with the final value (`overridden by helm.values: 3`).
- Next to a value equal to the chart default: `= chart default`.
- A problem on a key that the chart neither defaults nor reads, which points at a misspelled or outdated key.
- Next to each `.Values` read in a chart template: the final value of that release.
- On hover over a key: every layer that sets it, lowest first, each linked to its line.
- In the same hover, after a render: the rendered resources whose text holds the value.
  A chart default with the same text matches as well.
- Above `metadata.name` of an Application: the chart and the number of values layers, a link to the files of the chart and the state of the last render.
- The command `Helm Values Lens: Show Final Values` opens the merged values, each line commented with the file and line that set it.
- The command `Helm Values Lens: Show Rendered Manifests` opens the output of `helm template`.
- The command `Helm Values Lens: Open Chart File` opens a template or the values file of the chart, from the chart cache where it lives outside the workspace.

Opening the workspace renders each release with `helm template` in the background.
Saving a YAML file renders every release again.
A failed render shows as an error on the Application.
The status bar names the resources that the save changed.

## How it orders the layers

Argo CD hands Helm the layers of a release in this order, the last one winning:

1. the defaults of each dependency under its alias, then the defaults of the chart
2. `helm.valueFiles`, in their order
3. `helm.values`, or `helm.valuesObject` once both are set
4. `helm.parameters`, as `--set` and `--set-string`

A map merges into the map below it key by key.
A scalar or a list replaces whatever sat at its path.
A `null` deletes the key.
A dependency whose `condition` or `tags` turn it off contributes no defaults.
The test suite compares the merged values with the `COMPUTED VALUES` of `helm install --dry-run=client` for each release.

## Install

You need `helm` on your `PATH`, or its path in `helmValuesLens.helmPath`.
Build the extension and install it:

```sh
npm install
npm run package -- --out helm-values-lens.vsix
code --install-extension helm-values-lens.vsix
```

To print the trace of each release in a repository without VS Code, run `npm run trace -- <repository> [application]`.

## Where it works

- Applications with one source or with `sources`, a chart from a Helm repository, an OCI registry or a folder of the repository.
- `$<ref>/<path>` value files, once the repository of the `ref` source sits checked out in the workspace under the same remote URL.
- Value files relative to a chart folder of the workspace.

Charts from a repository get pulled once per version into the extension's storage.
An ApplicationSet, a Helmfile, a Kustomize `helmCharts` entry and a value file by URL get no lookup.
A parameter setting a list item (`list[0].name`) stays out of the trace.
The globals that Helm copies from a parent into its dependencies at render time stay out of the trace as well.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `helmValuesLens.helmPath` | `helm` | The binary that pulls and renders the charts. |
| `helmValuesLens.renderOnSave` | `true` | Renders each release with `helm template` once the workspace opens and after each save. |

## License

MIT
