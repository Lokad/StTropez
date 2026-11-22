import type { Page } from "@playwright/test";

/** Capture the primary document's identity before issuing a diagnostic injection. */
export async function sourceDiagnosticUri(page: Page): Promise<string> {
    return page.evaluate(() => window.hostFixture.snapshot().source.uri);
}

export async function publishFixtureDiagnostics(page: Page, uri: string, mode: string): Promise<void> {
    await page.evaluate(params => window.hostFixture.providerCustom("fixture/diagnostics", params), { uri, mode });
}
