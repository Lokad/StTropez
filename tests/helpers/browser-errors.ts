import assert from "node:assert/strict";
import type { BrowserContext, ConsoleMessage, WebError } from "@playwright/test";

/** One policy for Playwright specs and standalone demo qualification, including secondary pages. */
export function captureBrowserErrors(context: BrowserContext) {
    const errors: string[] = [];
    const expectedConsole: { text: string; url: string }[] = [];
    const pageError = (event: WebError) => errors.push(`pageerror at ${event.page()?.url() ?? "unknown page"}: ${event.error().stack ?? event.error().message}`);
    const consoleError = (message: ConsoleMessage) => {
        if (message.type() !== "error") return;
        const expected = expectedConsole.findIndex(value => value.text === message.text() && value.url === message.location().url);
        if (expected >= 0) { expectedConsole.splice(expected, 1); return; }
        errors.push(`console.error at ${message.page()?.url() ?? "unknown page"}: ${message.text()}`);
    };
    context.on("weberror", pageError); context.on("console", consoleError);
    return {
        // Fault-injection tests may permit one exact browser-generated network diagnostic.
        // Some engines emit none; extra messages, other URLs and uncaught errors still fail.
        allowConsoleError: (text: string, url: string) => { expectedConsole.push({ text, url }); },
        assertClean: () => assert.deepEqual(errors, [], "Unexpected browser errors"),
        dispose: () => { context.off("weberror", pageError); context.off("console", consoleError); },
    };
}
