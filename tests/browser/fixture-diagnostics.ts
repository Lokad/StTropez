import type { Page } from "@playwright/test";
import { fixtureDocumentUri } from "../../fixtures/protocol/document-uri.ts";

/** Capture the primary document's identity before issuing a diagnostic injection. */
export async function sourceDiagnosticUri(page: Page): Promise<string> {
    const target = await page.evaluate(() => {
        const state = window.hostFixture.snapshot(), primary = state.bindings.language.sessions.find(session => session.id === "primary");
        if (!primary) throw new Error("Primary language session is unavailable.");
        return { resource: state.source.id, document: primary.documentId };
    });
    return fixtureDocumentUri(target.resource, target.document);
}

export async function publishFixtureDiagnostics(page: Page, uri: string, mode: string): Promise<void> {
    await page.evaluate(params => window.hostFixture.providerCustom("fixture/diagnostics", params), { uri, mode });
}
