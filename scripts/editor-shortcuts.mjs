import { readFile, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";

const file = new URL("../docs/editor.md", import.meta.url);
const begin = "<!-- default shortcuts -->";
const end = "<!-- end default shortcuts -->";
const harness = await openHarness();
try {
    const { page } = harness;
    await page.addInitScript(() => {
        const value = new URL(location.href).searchParams.get("platform");
        if (value) Object.defineProperty(navigator, "platform", { value });
    });
    /** @param {string} platform */
    async function read(platform) {
        await page.goto("/controls/?platform=" + platform);
        return page.evaluate(async () => {
            const path = "/controls/app.js";
            const fixture = /** @type {typeof import("../tests/fixtures/controls/main.ts")} */ (await import(path));
            return fixture.readDefaultShortcuts();
        });
    }
    const standard = await read("Win32");
    const apple = await read("MacIntel");
    const commands = new Map([...standard, ...apple].map((row) => [row.id, row.category]));
    const standardKeys = new Map(standard.map((row) => [row.id, row.keys]));
    const appleKeys = new Map(apple.map((row) => [row.id, row.keys]));
    const lines = [begin, "", "| Category | Command | Keys | Platform |", "| --- | --- | --- | --- |"];
    const ordered = [...commands].sort(([a, x], [b, y]) => x.localeCompare(y, "en") || a.localeCompare(b, "en"));
    for (const [id, category] of ordered) {
        const keys = standardKeys.get(id) ?? [];
        const mac = appleKeys.get(id) ?? [];
        const bindings = [
            { platform: "All", keys: keys.filter((key) => mac.includes(key)) },
            { platform: "Windows/Linux", keys: keys.filter((key) => !mac.includes(key)) },
            { platform: "Apple", keys: mac.filter((key) => !keys.includes(key)) }
        ];
        for (const binding of bindings) {
            if (!binding.keys.length) continue;
            const keys = binding.keys.map((key) => "`" + key + "`").join(", ");
            lines.push(`| ${category} | \`${id}\` | ${keys} | ${binding.platform} |`);
        }
    }
    const markdown = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
    const first = markdown.indexOf(begin);
    const last = markdown.indexOf(end, first);
    if (first < 0 || last < first) throw new Error("Missing default shortcut markers in docs/editor.md.");
    const next = markdown.slice(0, first) + [...lines, "", end].join("\n") + markdown.slice(last + end.length);
    if (process.argv.includes("--write")) await writeFile(file, next);
    else if (next !== markdown)
        throw new Error("Refresh docs/editor.md with node scripts/editor-shortcuts.mjs --write.");
    console.log(`Read default shortcuts for ${commands.size} commands.`);
} finally {
    await harness.close();
}
