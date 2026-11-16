import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleSpecifiers } from "./module-specifiers.mjs";
import { apiPages, subjectPages, documentationPages, publicEntries as entries, parseDocumentation, auditPage, auditLinks, publicValues, auditValueCoverage } from "./documentation-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function documentationExamples(path, markdown) {
    const page = parseDocumentation(path, markdown);
    const issue = page.diagnostics.find(issue => issue.code === "fence");
    if (issue) throw new Error(`${path}:${issue.line}: ${issue.message}`);
    return page.examples;
}

/** Compile each example as its own module against the public source entry points. */
export async function compileDocumentation(examples) {
    if (!examples.length) throw new Error("No TypeScript documentation examples found.");
    for (const example of examples) {
        let specifiers;
        try { specifiers = moduleSpecifiers(`${example.path}.${example.language === "tsx" ? "tsx" : "ts"}`, example.code); }
        catch (error) {
            const line = example.line + example.code.slice(0, error.offset ?? 0).split("\n").length - 1;
            throw new Error(`${example.path}:${line}: ${error.message}`, { cause: error });
        }
        for (const specifier of specifiers) {
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
    const actual = (await readdir(resolve(root, "docs"))).map(name => `docs/${name}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...subjectPages].sort())) throw new Error("docs/: Update the subject-page inventory when adding or removing a page.");
    const read = path => readFile(resolve(root, path), "utf8");
    const pages = await Promise.all(documentationPages.map(async path => parseDocumentation(path, await read(path))));
    const inventory = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (inventory.error || inventory.status !== 0) throw inventory.error ?? new Error(inventory.stderr);
    const files = new Set(inventory.stdout.split("\0").filter(Boolean));
    const values = await publicValues(root);
    const issues = pages.flatMap(page => auditPage(page, { api: apiPages.includes(page.path), vocabulary: page.path !== "AGENTS.md" }));
    issues.push(...await auditLinks(pages, files, read), ...auditValueCoverage(values, pages));
    if (issues.length) throw new Error(issues.map(issue => `${issue.path}:${issue.line}: [${issue.code}] ${issue.message}`).join("\n"));
    const examples = pages.flatMap(page => page.examples), result = await compileDocumentation(examples);
    if (!result.success) throw new Error(result.output || "Documentation compilation failed.");
    console.log(`Checked ${pages.length} documents, repository links/anchors, ${values.length} public values and prose; compiled ${examples.length} independent TypeScript examples.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
