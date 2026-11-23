import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import Ajv2019 from "ajv/dist/2019"
import Ajv2020 from "ajv/dist/2020"
import { isPlainMap, valueAt } from "./coalesce"
import { firstLine } from "./text"
import { dottedPath, type ValuePath } from "./yamlPaths"

type SchemaNode = Record<string, unknown>

/** The `values.schema.json` of a chart or of a dependency, which checks the values under `prefix`. */
export interface ChartSchema {
    prefix: ValuePath
    fsPath: string
    /** Names the schema in a message, such as `values.schema.json` or `redis values.schema.json`. */
    label: string
    /** Undefined where the file holds no JSON object. */
    schema: SchemaNode | undefined
    /** Why the file did not parse. */
    error: string | undefined
}

/** What the schemas say about one key. */
export interface SchemaField {
    description: string | undefined
    type: string | undefined
    enum: readonly unknown[] | undefined
}

/** A value that a schema rejects. */
export interface SchemaError {
    /** The deepest map key that leads to the value, which a values file can set. */
    path: ValuePath
    message: string
}

/** Reads the `values.schema.json` beside the `values.yaml` of a chart, or undefined where the chart has none. */
export function readSchema(dir: string, prefix: ValuePath, label: string): ChartSchema | undefined {
    const fsPath = join(dir, "values.schema.json")
    if (!existsSync(fsPath)) return undefined
    try {
        const schema: unknown = JSON.parse(readFileSync(fsPath, "utf8"))
        if (!isPlainMap(schema))
            return { prefix, fsPath, label, schema: undefined, error: "no JSON object" }
        return { prefix, fsPath, label, schema, error: undefined }
    } catch (error) {
        return { prefix, fsPath, label, schema: undefined, error: firstLine(error) }
    }
}

/**
 * Checks the values as `helm template` does: each schema checks the values under its prefix.
 * A schema that does not compile adds a problem and checks nothing.
 */
export function schemaErrors(
    schemas: readonly ChartSchema[],
    values: unknown,
    problems: string[]
): SchemaError[] {
    const errors: SchemaError[] = []
    for (const schema of schemas) {
        if (schema.error !== undefined) {
            problems.push(`${schema.label}: ${schema.error}`)
            continue
        }
        const validate = validator(schema)
        if (typeof validate === "string") {
            problems.push(`${schema.label}: ${validate}`)
            continue
        }
        const scoped = valueAt(values, schema.prefix) ?? {}
        if (validate(scoped)) continue
        for (const error of validate.errors ?? []) errors.push(schemaError(schema, scoped, error))
    }
    return errors
}

const compiled = new WeakMap<SchemaNode, ValidateFunction | string>()
const engines = new Map<string, Ajv>()

/** Compiles a schema once, with the draft that its `$schema` names, or hands back why it did not compile. */
function validator(schema: ChartSchema): ValidateFunction | string {
    const node = schema.schema!
    const known = compiled.get(node)
    if (known !== undefined) return known
    const draft = String(node.$schema ?? "")
    const name = draft.includes("2020-12") ? "2020" : draft.includes("2019-09") ? "2019" : "07"
    let engine = engines.get(name)
    if (engine === undefined) {
        const options = {
            strict: false,
            allErrors: true,
            validateSchema: false,
            validateFormats: false,
            logger: false
        } as const
        engine =
            name === "2020"
                ? new Ajv2020(options)
                : name === "2019"
                  ? new Ajv2019(options)
                  : new Ajv(options)
        engines.set(name, engine)
    }
    let result: ValidateFunction | string
    try {
        const { $schema: _draft, $id: _id, ...rest } = node
        result = engine.compile(rest)
    } catch (error) {
        result = firstLine(error)
    }
    compiled.set(node, result)
    return result
}

function schemaError(schema: ChartSchema, scoped: unknown, error: ErrorObject): SchemaError {
    const segments = error.instancePath
        .split("/")
        .slice(1)
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    const params = error.params as Record<string, unknown>
    const named =
        error.keyword === "required"
            ? String(params.missingProperty)
            : error.keyword === "additionalProperties"
              ? String(params.additionalProperty)
              : undefined
    if (named !== undefined) segments.push(named)
    let mapLength = 0
    let current = scoped
    while (mapLength < segments.length && isPlainMap(current) && segments[mapLength]! in current)
        current = current[segments[mapLength++]!]
    const path = [...schema.prefix, ...segments.slice(0, mapLength)]
    const rest = segments
        .slice(mapLength)
        .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
        .join("")
    const subject = (path.length === 0 ? "the values" : dottedPath(path)) + rest
    return { path, message: `${subject} ${errorText(error, params)} (${schema.label})` }
}

function errorText(error: ErrorObject, params: Record<string, unknown>): string {
    switch (error.keyword) {
        case "required":
            return "is required"
        case "additionalProperties":
            return "is not allowed"
        case "enum":
            return `must be one of ${(params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(", ")}`
        default:
            return error.message ?? error.keyword
    }
}

/** The keys that the schemas name inside the map at `parent`. */
export function schemaKeys(schemas: readonly ChartSchema[], parent: ValuePath): Set<string> {
    const keys = new Set<string>()
    for (const node of nodesAt(schemas, parent))
        for (const key of Object.keys(asNode(node.properties) ?? {})) keys.add(key)
    return keys
}

/** What the schemas say about the key at `path`, or undefined where no schema names it. */
export function schemaField(
    schemas: readonly ChartSchema[],
    path: ValuePath
): SchemaField | undefined {
    const nodes = nodesAt(schemas, path)
    if (nodes.length === 0) return undefined
    const first = <T>(read: (node: SchemaNode) => T | undefined) =>
        nodes.map(read).find((value) => value !== undefined)
    return {
        description: first((node) =>
            typeof node.description === "string" ? node.description : undefined
        ),
        type: first((node) =>
            typeof node.type === "string"
                ? node.type
                : Array.isArray(node.type)
                  ? node.type.join(" or ")
                  : undefined
        ),
        enum: first((node) => (Array.isArray(node.enum) ? node.enum : undefined))
    }
}

/** The schema nodes that describe the value at `path`, each `$ref` and `allOf`, `anyOf` or `oneOf` followed. */
function nodesAt(schemas: readonly ChartSchema[], path: ValuePath): SchemaNode[] {
    const nodes: SchemaNode[] = []
    for (const { prefix, schema } of schemas) {
        if (schema === undefined || !prefix.every((segment, index) => path[index] === segment))
            continue
        let current = expanded(schema, schema)
        for (const segment of path.slice(prefix.length))
            current = current.flatMap((node) => {
                const child =
                    asNode(asNode(node.properties)?.[segment]) ??
                    Object.entries(asNode(node.patternProperties) ?? {}).find(([pattern]) =>
                        safeTest(pattern, segment)
                    )?.[1] ??
                    node.additionalProperties
                return asNode(child) === undefined ? [] : expanded(schema, asNode(child)!)
            })
        nodes.push(...current)
    }
    return nodes
}

/** Follows a local `$ref` and spreads `allOf`, `anyOf` and `oneOf`, a few levels deep against cycles. */
function expanded(root: SchemaNode, node: SchemaNode, depth = 0): SchemaNode[] {
    if (depth > 8) return []
    const nodes = [node]
    if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
        const target = asNode(pointer(root, node.$ref.slice(1)))
        if (target !== undefined) nodes.push(...expanded(root, target, depth + 1))
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"])
        for (const part of Array.isArray(node[keyword]) ? (node[keyword] as unknown[]) : []) {
            const child = asNode(part)
            if (child !== undefined) nodes.push(...expanded(root, child, depth + 1))
        }
    return nodes
}

function pointer(root: SchemaNode, path: string): unknown {
    return path
        .split("/")
        .slice(1)
        .map((segment) => decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~"))
        .reduce<unknown>((node, segment) => (isPlainMap(node) ? node[segment] : undefined), root)
}

function asNode(value: unknown): SchemaNode | undefined {
    return isPlainMap(value) ? value : undefined
}

function safeTest(pattern: string, text: string): boolean {
    try {
        return new RegExp(pattern, "u").test(text)
    } catch {
        return false
    }
}
