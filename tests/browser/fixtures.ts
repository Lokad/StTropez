import { test as base, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

export { expect };

export async function expectPanelKeyReserved(control: Locator, key: "Escape" | "Enter") {
    const consumed = await control.evaluate((node, key) => [
        { keyCode: 229 }, { modifierAltGraph: true }, { isComposing: true }, { shiftKey: true },
    ].map(detail => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...detail });
        node.dispatchEvent(event);
        return event.defaultPrevented;
    }), key);
    expect(consumed).toEqual([false, false, false, false]);
    await expect(control).toBeFocused();
}

/** A single-source fixture keeps recovery and its provider owner while DOM views detach. */
export function expectUnmountedSourceHost(state: ReturnType<Window["hostFixture"]["snapshot"]>, additionalSubscriptions = 0): void {
    expect(state.bindings.activeViews).toBe(0);
    expect(state.bindings.lsp).toMatchObject({ disposed: false, scopes: 1, documents: 1, documentParticipants: 1 });
    // Recovery observes source content/metadata, configuration and transfer; LSP observes source.
    expect(state.diagnostics.subscriptions).toBe(5 + additionalSubscriptions);
    // Recovery watches loaded-source/recovery cells; actions retain their project-review observer.
    expect(state.bindings.project.subscriptions).toBe(1);
    expect(state.hostSubscriptions).toBe(3);
}

/** Scheduled editor work only. Specs separately await services, mount counts and native controls. */
export async function ready(page: Page, timeout = 30_000): Promise<void> {
    await page.waitForFunction(() => (window.hostFixture ?? window.editingFixture ?? window.viewportFixture ?? window.comparisonFixture)?.settled === true,
        undefined, { timeout });
}

export const test = base.extend<{ browserErrors: ReturnType<typeof captureBrowserErrors> }>({
    browserErrors: [async ({ context }, use) => {
        const errors = captureBrowserErrors(context);
        try { await use(errors); }
        finally { errors.dispose(); errors.assertClean(); }
    }, { auto: true }],
});

// Protocol journeys own their background process; teardown avoids the unresolved Firefox
// context-deletion path while still applying the same error guard to their actual context.
export const isolatedTest = test.extend({ context: async ({ playwright, browserName, baseURL }, use) => {
    const browser = await playwright[browserName].launch({ headless: true });
    try { await use(await browser.newContext({ ...(baseURL ? { baseURL } : {}), viewport: { width: 1440, height: 900 } })); }
    finally { await browser.close(); }
} });
