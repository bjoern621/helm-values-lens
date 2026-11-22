# Helm Values Lens

Helm Values Lens shows in VS Code, next to each line of a values file, the value that the Helm chart ends up with.
A value often gets set in several files, such as the chart's `values.yaml`, a `values-production.yaml` and the Argo CD Application that deploys the chart.
Each of these files adds a layer of values.
The last layer wins.
The hint names that layer and its value.

The extension reads which files feed a release, and in which order, from the file that deploys the chart: an Argo CD Application or ApplicationSet, a `helmfile.yaml`, a Flux HelmRelease or a `kustomization.yaml` with `helmCharts`.
A repository holding one of those needs no settings.

![A values file with the hints of the release picked in the status bar and the hover listing every release that reads the file](docs/values-file.png)

## What it shows

- Next to a value in a values file: the layer that overrides or deletes it, with the final value (`overridden by values-staging.yaml: 1.27-rc`).
- Next to a value that a later layer sets to the same value: `also set by helm.valuesObject`.
- Next to a value equal to the chart default: `= chart default`.
- An information marker on a key that the chart neither defaults nor reads, most likely a misspelled or outdated key.
- Next to each `.Values` read in a chart template: the final value of the release.
- On hover over a key: every layer that sets it, lowest first, each linked to its line, for every release that reads the file.
- In the same hover, after a render: the rendered resources whose text holds the value.
  A chart default with the same text matches as well.
- Above the release in its Application, Helmfile, HelmRelease or kustomization: the chart, the number of values layers, a link to the files of the chart and the state of the last render.
- A problem marker on the release where its chart could not be loaded or `helm template` could not render it.

![A chart template that renders an Argo CD Application, with the final value after each .Values read and a summary of each release above metadata.name](docs/template.png)

## Use

Open the folder that holds your deployment files.
The extension finds the releases, loads their charts and renders each one with `helm template` in the background.
Hints update while you type.
Saving a file renders every release again.
The status bar then names the resources that the save changed.

One values file often feeds several releases, such as one chart deployed to staging and production.
The status bar names the release whose values the hints show, with the number of releases that read the file.
To pick another release or all of them, click it or run `Helm Values Lens: Select Release for Hints`.

![The picker listing the releases that read the active file](docs/release-picker.png)

The commands, under `Helm Values Lens:` in the command palette:

| Command                                     | Effect                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Show Final Values`                         | Opens the merged values of a release, each line commented with the file and line that set it.            |
| `Show Rendered Manifests`                   | Opens the output of `helm template` for a release.                                                       |
| `Render Release`                            | Renders one release again.                                                                               |
| `Open Chart File`                           | Opens a template or values file of the chart, from the chart cache where it lives outside the workspace. |
| `Select Release for Hints`                  | Lets you pick the release whose values the hints show.                                                   |
| `Add Release from a Chart and Values Files` | Adds a release to the `helmValuesLens.releases` setting.                                                 |
| `Reload Releases`                           | Reads every release and chart again.                                                                     |

The trace of a release lists each value with the layers that set it.
To print the trace of each release without VS Code, run `npm run trace -- <folder> [release]`.

## How it orders the layers

Each tool hands Helm the values of a release in its own order, the last layer winning.
For Argo CD:

1. the defaults of each dependency under its alias, then the defaults of the chart
2. `helm.valueFiles`, in their order
3. `helm.values`, or `helm.valuesObject` once both are set
4. `helm.parameters`, as `--set` and `--set-string`

Helmfile puts `values` before `set` and `setString`.
Flux puts `valuesFrom` without a `targetPath` before `values` and the ones with a `targetPath` after.
Kustomize merges `valuesInline` into `valuesFile` as `valuesMerge` says, then adds each of `additionalValuesFiles`.

A map merges into the map below it key by key.
A scalar or a list replaces whatever sat at its path.
A `null` deletes the key.
A dependency whose `condition` or `tags` turn it off contributes no defaults.
The test suite compares the merged values with the `COMPUTED VALUES` of `helm install --dry-run=client` for each release.
Where `helmfile` and `kustomize` sit on the `PATH`, it compares with their output as well.

## Where it works

| Setup                        | What gets read                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Argo CD Application          | One source or `sources`. A chart from a Helm repository, an OCI registry or a folder. `$<ref>/<path>` values files.                                           |
| App of apps                  | The Applications in the `helm template` output of a chart, nested a few levels deep.                                                                          |
| Argo CD ApplicationSet       | The `list`, `git`, `matrix` and `merge` generators. Generators that read state outside the repository, such as `clusters` or `pullRequest`, yield no release. |
| Helmfile                     | `helmfile.yaml` and `helmfile.yaml.gotmpl`. One release per environment where the environments render it apart.                                               |
| Flux HelmRelease             | A chart from a HelmRepository, GitRepository, OCIRepository or HelmChart. `valuesFrom` ConfigMaps and Secrets from the repository or a kustomize generator.   |
| Kustomize                    | `helmCharts` with `valuesFile`, `valuesInline`, `valuesMerge` and `additionalValuesFiles`.                                                                    |
| A chart that nothing deploys | One release with the chart defaults. One more per `values-<name>.yaml` beside its `values.yaml`.                                                              |

For any other order, add a release to the `helmValuesLens.releases` setting.

A repository URL resolves to a folder of the workspace in this order:

1. the `helmValuesLens.repositories` setting
2. the Git remotes of each checkout
3. the one folder whose path ends with the path of the URL

Charts from a Helm repository or an OCI registry get pulled once per version into the extension's storage.

These stay out of the trace:

- A values file by URL.
- A parameter setting a list item (`list[0].name`).
- The globals that Helm copies from a parent into its dependencies at render time.
- Helmfile `secrets`.
- Helmfile template expressions beyond `.Environment.Name`, `.Release.Name` and `.Release.Namespace`.
  A layer holding another expression shows a warning on the release.
- Flux `valuesFiles` that leave out `values.yaml`: Flux then drops the chart defaults, which the trace keeps.
- A list of maps under Kustomize `valuesInline`, which Kustomize merges by a key such as `name`.
  The trace replaces it whole.

## Install

`helm` must sit on your `PATH`, or `helmValuesLens.helmPath` must hold its path.
Build the extension and install it:

```sh
npm install
npm run package -- --out helm-values-lens.vsix
code --install-extension helm-values-lens.vsix
```

## Settings

| Setting                       | Default | Effect                                                                                               |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `helmValuesLens.helmPath`     | `helm`  | The binary that pulls and renders the charts.                                                        |
| `helmValuesLens.renderOnSave` | `true`  | Renders each release with `helm template` once the workspace opens and after each save.              |
| `helmValuesLens.releases`     | `[]`    | Releases that no deployment file describes, each a chart folder with its values files, lowest first. |
| `helmValuesLens.repositories` | `{}`    | Repository URLs mapped to folders, for a checkout whose remote and path name neither URL.            |

A release in the setting, with paths relative to the first workspace folder:

```jsonc
// .vscode/settings.json
{
    "helmValuesLens.releases": [
        {
            "name": "web-staging",
            "chart": "charts/web",
            "valueFiles": ["charts/web/values-staging.yaml", "overrides/staging.yaml"],
            "set": { "image.tag": "1.28" }
        }
    ],
    "helmValuesLens.repositories": {
        "https://git.example.com/acme/gitops.git": "gitops"
    }
}
```

## License

MIT
