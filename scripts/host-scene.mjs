import assert from "node:assert/strict";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

/** Shared fixture mechanics; callers own review preparation, gestures and clocks.
 * @param {import('@playwright/test').Page} page
 */
export function createHostScene(page) {
    let mounted = false;
    const snapshot = () => page.evaluate(() => window.hostFixture.snapshot());
    return Object.freeze({
        get mounted() { return mounted; },
        snapshot,
        ready: () => page.evaluate(() => window.hostReferenceProbe.waitReady()),
        sourceReady: () => page.evaluate(() => window.hostReferenceProbe.waitSourceReady()),
        /** @param {string} host @param {'native' | 'candidate'} [editor] */
        async mount(host, editor = "candidate") {
            assert.equal(mounted, false, "Dispose the current host scene before mounting another.");
            assert.ok(editor === "candidate" || editor === "native", "Select a fixture editor.");
            await page.goto(`/hosts/${host}/?editor=${editor}`);
            await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
            mounted = true;
            await page.evaluate(installHostReferenceProbe);
        },
        /** @param {() => void | Promise<void>} [observe] */
        async dispose(observe) {
            if (!mounted) return;
            await page.evaluate(() => window.hostFixture.dispose()); mounted = false;
            // Close a caller-owned disposal clock before collecting teardown diagnostics.
            await observe?.();
            const state = await snapshot();
            for (const key of /** @type {const} */ (["views", "leases", "subscriptions"])) assert.equal(state.diagnostics[key], 0, key);
            assert.equal(state.hostSubscriptions, 0, "host subscriptions");
            return state;
        },
        // This whole-document oracle belongs outside interaction clocks.
        /** @param {string} text @param {'source' | 'reference'} [target] */
        exactText(text, target = "source") {
            assert.ok(target === "source" || target === "reference", "Select source or reference text.");
            return page.evaluate(({ text, target }) => {
                const f = window.hostFixture, state = f.snapshot();
                const length = target === "source" ? state.source.length : state.bindings.comparison?.baseline?.length;
                if (length !== text.length) return false;
                for (let from = 0; from < length; from += 32768) {
                    const to = Math.min(length, from + 32768);
                    const actual = target === "source" ? f.range(from, to) : f.referenceRange(from, to);
                    if (actual !== text.slice(from, to)) return false;
                }
                return true;
            }, { text, target });
        },
    });
}
