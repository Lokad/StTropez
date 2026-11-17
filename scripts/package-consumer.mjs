import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** @param {string} path */
export async function emptyConsumerDirectory(path) {
    const absolute = resolve(path), parent = await realpath(tmpdir());
    assert.equal(dirname(absolute), parent, "A new consumer must be directly inside the temporary directory.");
    assert.ok(basename(absolute).startsWith("sttropez-consumer-"), "Expected a package consumer directory.");
    assert.ok((await lstat(absolute)).isDirectory(), "A new consumer cannot be a link.");
    assert.equal(await realpath(absolute), absolute, "A new consumer cannot redirect to another directory.");
    assert.deepEqual(await readdir(absolute), [], "A new consumer directory must be empty.");
    return absolute;
}

/** @param {string} root */
async function footprint(root) {
    const result = { files: 0, directories: 0, links: 0, bytes: 0 };
    /** @param {string} directory */
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) result.links++;
            else if (entry.isDirectory()) { result.directories++; await visit(path); }
            else if (entry.isFile()) { result.files++; result.bytes += (await lstat(path)).size; }
            else throw new Error(`Unexpected consumer entry: ${path}`);
        }
    }
    await visit(root);
    return result;
}

/** @typedef {{files: number, directories: number, links: number, bytes: number}} Footprint */
/** @typedef {{consumer: string, state: "running" | "removing" | "removed" | "kept" | "failed", removed: boolean, before?: Footprint, after?: Footprint, error?: string}} ConsumerRetention */

/**
 * Only a directory created here can be removed. Evidence is recorded outside it before removal.
 * @param {{keep: boolean, record: (retention: ConsumerRetention) => Promise<void>}} options
 * @param {(consumer: string) => Promise<void>} qualify
 */
export async function withPackageConsumer({ keep, record }, qualify) {
    const parent = await realpath(tmpdir()), consumer = await mkdtemp(join(parent, "sttropez-consumer-"));
    const identity = await lstat(consumer, { bigint: true });
    /** @type {ConsumerRetention} */
    let retention = { consumer, state: "running", removed: false };
    async function verifyOwner() {
        assert.equal(dirname(consumer), parent, "Consumer escaped the temporary directory.");
        assert.equal(await realpath(consumer), consumer, "Consumer root was redirected.");
        const current = await lstat(consumer, { bigint: true });
        assert.ok(current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino,
            "Consumer root was replaced; refusing cleanup.");
    }
    try {
        await record(retention);
        await qualify(consumer);
        await verifyOwner();
        retention = { ...retention, before: await footprint(consumer), state: keep ? "kept" : "removing" };
        // A failed receipt write leaves the directory available for inspection.
        await record(retention);
        if (!keep) {
            await verifyOwner();
            await rm(consumer, { recursive: true });
            retention = { ...retention, state: "removed", removed: true,
                after: { files: 0, directories: 0, links: 0, bytes: 0 } };
            await record(retention);
        }
        return retention;
    } catch (error) {
        retention = { ...retention, state: "failed", error: error instanceof Error ? error.message : String(error) };
        try { await record(retention); }
        catch (recordError) { throw new AggregateError([error, recordError], `Consumer evidence failed: ${consumer}`); }
        throw error;
    }
}
