import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

test("reloading the reference host picks up an HTML edit on the running development server", async t => {
    const root = process.cwd();
    const scratch = join(root, "artifacts");
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, "dev-pages-"));
    assert.equal(dirname(dir), scratch);
    try {
        await cp(join(root, "examples"), join(dir, "examples"), { recursive: true });
        for (const name of ["node_modules", "src", "tests"]) {
            await symlink(join(root, name), join(dir, name), "junction");
        }
        // The bundler captures its working directory on import.
        process.chdir(dir);
        const { startServer } = await import("../../scripts/serve.mjs");
        const server = await startServer(0);
        try {
            const file = join(dir, "examples/reference/index.html");
            const original = await readFile(file, "utf8");
            const page = server.url + "/reference/";
            assert.equal(await (await fetch(page)).text(), original);
            const edited = original + "\n<!-- updated host -->";
            await writeFile(file, edited);
            await t.waitFor(async () => assert.equal(await (await fetch(page)).text(), edited), { timeout: 10000 });
            assert.equal(await (await fetch(page + "index.html")).text(), edited);
        } finally {
            await server.close();
        }
    } finally {
        process.chdir(root);
        const { stop } = await import("esbuild");
        await stop();
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
});
