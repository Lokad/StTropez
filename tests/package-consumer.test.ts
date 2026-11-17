import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyConsumerDirectory, withPackageConsumer, type ConsumerRetention } from "../scripts/package-consumer.mjs";

async function cleanup(t: TestContext, path: string) {
    const parent = await realpath(tmpdir());
    assert.equal(dirname(path), parent);
    t.after(async () => {
        const info = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (!info) return;
        if (info.isSymbolicLink()) await unlink(path);
        else {
            assert.equal(await realpath(path), path);
            assert.equal(dirname(path), parent);
            await rm(path, { recursive: true });
        }
    });
}

test("package qualification removes only its own consumer and records its footprint without following links", async t => {
    const borrowed = await mkdtemp(join(await realpath(tmpdir()), "sttropez-consumer-borrowed-"));
    await cleanup(t, borrowed);
    await writeFile(join(borrowed, "keep.txt"), "borrowed data");
    const states: string[] = [];
    const receipt = await withPackageConsumer({ keep: false, record: async value => { states.push(value.state); } }, async consumer => {
        await cleanup(t, consumer);
        assert.equal(await emptyConsumerDirectory(consumer), consumer);
        await mkdir(join(consumer, "nested"));
        await writeFile(join(consumer, "nested", "data.txt"), "hello");
        await symlink(borrowed, join(consumer, "borrowed"), process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(emptyConsumerDirectory(consumer), /must be empty/);
    });
    assert.deepEqual(states, ["running", "removing", "removed"]);
    assert.deepEqual(receipt.before, { files: 1, directories: 1, links: 1, bytes: 5 });
    assert.deepEqual(receipt.after, { files: 0, directories: 0, links: 0, bytes: 0 });
    assert.equal(receipt.removed, true);
    await assert.rejects(lstat(receipt.consumer), { code: "ENOENT" });
    assert.equal(await readFile(join(borrowed, "keep.txt"), "utf8"), "borrowed data");
    await assert.rejects(emptyConsumerDirectory(borrowed), /must be empty/);
    await assert.rejects(emptyConsumerDirectory(await realpath(tmpdir())), /directly inside/);
});

test("explicit package consumer retention preserves successful inspection data", async t => {
    const receipt = await withPackageConsumer({ keep: true, record: async () => {} }, async consumer => {
        await cleanup(t, consumer);
        await writeFile(join(consumer, "data.txt"), "inspect");
    });
    assert.equal(receipt.state, "kept");
    assert.equal(receipt.removed, false);
    assert.equal(await readFile(join(receipt.consumer, "data.txt"), "utf8"), "inspect");
});

test("failed package qualification retains its consumer and the original failure", async t => {
    const failure = new Error("qualification failed"), records: ConsumerRetention[] = [];
    await assert.rejects(withPackageConsumer({ keep: false, record: async value => { records.push(value); } }, async consumer => {
        await cleanup(t, consumer);
        await writeFile(join(consumer, "failure.txt"), "diagnostic");
        throw failure;
    }), error => error === failure);
    assert.deepEqual(records.map(value => value.state), ["running", "failed"]);
    assert.equal(records.at(-1)!.removed, false);
    assert.equal(records.at(-1)!.error, failure.message);
    assert.equal(await readFile(join(records[0]!.consumer, "failure.txt"), "utf8"), "diagnostic");
});

test("a replaced package consumer root never grants cleanup authority over a borrowed directory", async t => {
    const borrowed = await mkdtemp(join(await realpath(tmpdir()), "sttropez-consumer-borrowed-"));
    await cleanup(t, borrowed);
    await writeFile(join(borrowed, "keep.txt"), "keep");
    await assert.rejects(withPackageConsumer({ keep: false, record: async () => {} }, async consumer => {
        await cleanup(t, consumer);
        const moved = consumer + "-moved";
        assert.equal(dirname(moved), await realpath(tmpdir()));
        assert.equal(await realpath(consumer), consumer);
        await rename(consumer, moved);
        await cleanup(t, moved);
        await symlink(borrowed, consumer, process.platform === "win32" ? "junction" : "dir");
    }), /redirected/);
    assert.equal(await readFile(join(borrowed, "keep.txt"), "utf8"), "keep");
    let replacement = "";
    await assert.rejects(withPackageConsumer({ keep: false, record: async () => {} }, async consumer => {
        replacement = consumer;
        await cleanup(t, consumer);
        const moved = consumer + "-moved";
        assert.equal(dirname(moved), await realpath(tmpdir()));
        assert.equal(await realpath(consumer), consumer);
        await rename(consumer, moved);
        await cleanup(t, moved);
        await mkdir(consumer);
        await writeFile(join(consumer, "keep.txt"), "replacement");
    }), /replaced/);
    assert.equal(await readFile(join(replacement, "keep.txt"), "utf8"), "replacement");
});

test("package consumer cleanup requires a durable receipt before removal", async t => {
    const failure = new Error("receipt unavailable"), states: string[] = [];
    let root = "";
    await assert.rejects(withPackageConsumer({ keep: false, record: async value => {
        states.push(value.state);
        if (value.state === "removing") throw failure;
    } }, async consumer => {
        root = consumer;
        await cleanup(t, consumer);
        await writeFile(join(consumer, "keep.txt"), "evidence");
    }), error => error === failure);
    assert.deepEqual(states, ["running", "removing", "failed"]);
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "evidence");
});
