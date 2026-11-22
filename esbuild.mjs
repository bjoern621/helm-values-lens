import * as esbuild from "esbuild"

const builds = [
    {
        entryPoints: ["src/extension.ts"],
        outfile: "dist/extension.js",
        external: ["vscode"]
    },
    { entryPoints: ["src/cli.ts"], outfile: "dist/cli.js" }
]

for (const options of builds) {
    await esbuild.build({
        bundle: true,
        sourcemap: true,
        platform: "node",
        format: "cjs",
        logLevel: "warning",
        ...options
    })
}
