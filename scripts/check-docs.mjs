import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleSpecifiers } from "./module-specifiers.mjs";
import { apiIndexPath, renderApiIndex } from "./api-index.mjs";
import { apiPages, subjectPages, documentationPages, publicEntries as entries, exampleExtensions, parseDocumentation,
    auditPage, auditLinks, handbookWordBudget, proseWords } from "./documentation-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** @param {string} path @param {string} markdown */
export function documentationExamples(path, markdown) {
    const page = parseDocumentation(path, markdown);
    const issue = page.diagnostics.find(issue => issue.code === "fence");
    if (issue) throw new Error(`${path}:${issue.line}: ${issue.message}`);
    return page.examples;
}

/** Compile the examples against public entries. Named files can import a sibling on the same page.
 * @param {ReturnType<typeof parseDocumentation>["examples"]} examples */
export async function compileDocumentation(examples) {
    if (!examples.length) throw new Error("No documentation examples found.");
    const pages = [...new Set(examples.map(example => example.path))];
    const modules = examples.map((example, index) => {
        const extension = exampleExtensions.get(example.language);
        if (!extension) throw new Error(`Unknown example language ${example.language}.`);
        if (example.file === undefined) return { example, filename: `example-${index + 1}.${extension}` };
        if (!/^[\w-]+\.(?:js|ts|tsx)$/.test(example.file) || !example.file.endsWith("." + extension)) {
            throw new Error(`${example.path}:${example.line}: Invalid example filename ${JSON.stringify(example.file)}.`);
        }
        return { example, filename: join(String(pages.indexOf(example.path)), example.file) };
    });
    for (const { example, filename } of modules) {
        let specifiers;
        try { specifiers = moduleSpecifiers(filename, example.code); }
        catch (error) {
            if (!(error instanceof Error)) throw error;
            const offset = "offset" in error && typeof error.offset === "number" ? error.offset : 0;
            const line = example.line + example.code.slice(0, offset).split("\n").length - 1;
            throw new Error(`${example.path}:${line}: ${error.message}`, { cause: error });
        }
        for (const specifier of specifiers) {
            const sibling = example.file && examples.some(other => other.path === example.path
                && other.file !== undefined && specifier.value === "./" + other.file);
            if (!sibling && !Object.hasOwn(entries, specifier.value)) {
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
        for (const { example, filename } of modules) {
            const file = join(directory, filename);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, "\n".repeat(example.line - 1) + example.code + "\nexport {};\n");
            files.push(file);
        }
        const configuration = join(directory, "tsconfig.json");
        await writeFile(configuration, JSON.stringify({
            extends: resolve(root, "tsconfig.base.json"),
            compilerOptions: { noEmit: true, skipLibCheck: false, allowJs: true, checkJs: true, types: [],
                paths: Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, [resolve(root, path)]])) },
            files, include: [], exclude: []
        }, null, 2));
        const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", configuration, "--pretty", "false"],
            { cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true });
        if (result.error) throw result.error;
        let output = (result.stdout ?? "") + (result.stderr ?? "");
        for (const [index, file] of files.entries()) {
            // Each scratch file corresponds to the example at the same index.
            const example = /** @type {ReturnType<typeof parseDocumentation>["examples"][number]} */ (examples[index]);
            for (const path of [file, relative(root, file)]) {
                output = output.replaceAll(path, example.path).replaceAll(path.split(sep).join("/"), example.path);
            }
        }
        return { success: result.status === 0, output };
    } finally {
        if (dirname(resolve(directory)) !== scratch || !basename(directory).startsWith("compile-")) throw new Error("Unsafe documentation scratch path.");
        await rm(directory, { recursive: true, force: true });
    }
}

async function main() {
    const expectedIndex = renderApiIndex(root);
    const indexFile = resolve(root, apiIndexPath);
    if (process.argv.includes("--write-api-index")) {
        await writeFile(indexFile, expectedIndex);
    }
    const actual = (await readdir(resolve(root, "docs"))).map(name => `docs/${name}`).sort();
    if (!actual.includes(apiIndexPath) || (await readFile(indexFile, "utf8")).replaceAll("\r\n", "\n") !== expectedIndex) {
        throw new Error(`${apiIndexPath} is stale. Run npm run check:docs -- --write-api-index.`);
    }
    if (JSON.stringify(actual) !== JSON.stringify([...subjectPages].sort())) throw new Error("docs/: Update the subject-page inventory when adding or removing a page.");
    /** @param {string} path */
    const read = path => readFile(resolve(root, path), "utf8");
    const pages = await Promise.all(documentationPages.map(async path => parseDocumentation(path, await read(path))));
    const words = pages.filter(page => subjectPages.includes(page.path) && page.path !== apiIndexPath)
        .reduce((total, page) => total + proseWords(page), 0);
    if (words > handbookWordBudget) throw new Error(`Handbook prose has ${words} words against its ${handbookWordBudget}-word budget.`);
    const inventory = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (inventory.error || inventory.status !== 0) throw inventory.error ?? new Error(inventory.stderr);
    const files = new Set(inventory.stdout.split("\0").filter(Boolean));
    const issues = pages.flatMap(page => auditPage(page, { api: apiPages.includes(page.path), vocabulary: page.path !== "AGENTS.md" }));
    issues.push(...await auditLinks(pages, files, read));
    if (issues.length) throw new Error(issues.map(issue => `${issue.path}:${issue.line}: [${issue.code}] ${issue.message}`).join("\n"));
    const examples = pages.flatMap(page => page.examples), result = await compileDocumentation(examples);
    if (!result.success) throw new Error(result.output || "Documentation compilation failed.");
    console.log(`Checked ${pages.length} documents and ${words} handbook words. Compiled ${examples.length} example modules.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
