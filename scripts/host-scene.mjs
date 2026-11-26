import assert from "node:assert/strict";

/** Check every raw source/reference unit outside interaction clocks.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @param {'source' | 'reference'} [target]
 */
export function hostTextEquals(page, text, target = "source") {
    assert.ok(target === "source" || target === "reference", "Select source or reference text.");
    return page.evaluate(
        ({ text, target }) => {
            const f = window.hostFixture,
                state = f.snapshot();
            const length = target === "source" ? state.source.length : state.bindings.comparison?.baseline?.length;
            if (length !== text.length) return false;
            for (let from = 0; from < length; from += 32768) {
                const to = Math.min(length, from + 32768);
                const actual = target === "source" ? f.range(from, to) : f.referenceRange(from, to);
                if (actual !== text.slice(from, to)) return false;
            }
            return true;
        },
        { text, target }
    );
}
