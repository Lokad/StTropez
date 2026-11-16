import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleSpecifiers } from "./module-specifiers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Extend this list as subject pages replace the historical documentation.
const pages = ["getting-started", "viewport", "folding", "search", "comparison"].map(name => `docs/${name}.md`);
const entries = {
    sttropez: "src/index.ts",
    "sttropez/browser": "src/browser/index.ts",
    "sttropez/protocol": "src/protocol/index.ts"
};

/** Top-level fenced examples; other fenced content cannot open a nested example. */
export function documentationExamples(path, markdown) {
    const examples = [], lines = markdown.split(/\r?\n/);
    let fence;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (fence) {
            const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
            if (close && close[1][0] === fence.marker && close[1].length >= fence.size) {
                if (fence.language) examples.push({ path, line: fence.start + 2, language: fence.language, code: fence.lines.join("\n") });
                fence = undefined;
            } else fence.lines.push(line.slice(Math.min(fence.indent, /^ */.exec(line)[0].length)));
            continue;
        }
        const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
        if (!open || open[2][0] === "`" && open[3].includes("`")) continue;
        const info = open[3].trim().split(/\s+/)[0];
        fence = { marker: open[2][0], size: open[2].length, indent: open[1].length,
            language: ["ts", "typescript", "tsx"].includes(info) ? info : undefined, start: index, lines: [] };
    }
    if (fence) throw new Error(`${path}:${fence.start + 1}: Unclosed code fence.`);
    return examples;
}

/** Compile each example as its own module against the public source entry points. */
export async function compileDocumentation(examples) {
    if (!examples.length) throw new Error("No TypeScript documentation examples found.");
    for (const example of examples) {
        for (const specifier of moduleSpecifiers(`${example.path}.${example.language === "tsx" ? "tsx" : "ts"}`, example.code)) {
            if (!Object.hasOwn(entries, specifier.value)) {
                const line = example.line + example.code.slice(0, specifier.from).split("\n").length - 1;
                throw new Error(`${example.path}:${line}: Import ${JSON.stringify(specifier.value)} must use a public entry point.`);
            }
        }
    }
    const scratch = resolve(root, "artifacts/docs-check");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "compile-"));
    try {
        const files = [];
        for (const [index, example] of examples.entries()) {
            const file = join(directory, `example-${index + 1}.${example.language === "tsx" ? "tsx" : "ts"}`);
            await writeFile(file, "\n".repeat(example.line - 1) + example.code + "\nexport {};\n");
            files.push(file);
        }
        const configuration = join(directory, "tsconfig.json");
        await writeFile(configuration, JSON.stringify({
            extends: resolve(root, "tsconfig.json"),
            compilerOptions: { noEmit: true, skipLibCheck: false, types: [],
                paths: Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, [resolve(root, path)]])) },
            files, include: [], exclude: []
        }, null, 2));
        const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", configuration, "--pretty", "false"],
            { cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true });
        if (result.error) throw result.error;
        let output = (result.stdout ?? "") + (result.stderr ?? "");
        for (const [index, file] of files.entries()) {
            for (const path of [file, relative(root, file)]) {
                output = output.replaceAll(path, examples[index].path).replaceAll(path.split(sep).join("/"), examples[index].path);
            }
        }
        return { success: result.status === 0, output };
    } finally {
        if (dirname(resolve(directory)) !== scratch || !basename(directory).startsWith("compile-")) throw new Error("Unsafe documentation scratch path.");
        await rm(directory, { recursive: true, force: true });
    }
}

async function main() {
    const examples = [];
    for (const path of pages) {
        const found = documentationExamples(path, await readFile(resolve(root, path), "utf8"));
        if (!found.length) throw new Error(`${path}: Expected a TypeScript example.`);
        examples.push(...found);
    }
    const result = await compileDocumentation(examples);
    if (!result.success) throw new Error(result.output || "Documentation compilation failed.");
    console.log(`Compiled ${examples.length} independent TypeScript examples in ${pages.length} documentation pages.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
