import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";

/** @param {Awaited<ReturnType<typeof openHarness>>} harness */
async function captureDemo(harness) {
    await harness.page.goto("/");
    await harness.page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent?.includes("syntax & emit"));
    await harness.page.screenshot({ path: "artifacts/inspect/demo.png", fullPage: true });
}
async function inspect() {
const harness = await openHarness();
try {
    await mkdir("artifacts/inspect", { recursive: true });
    if (process.argv.includes("--demo-only")) { await captureDemo(harness); if (harness.errors.length) throw new Error(harness.errors.join("\n")); return; }
    await captureDemo(harness);
    for (const mode of ["plain", "react"]) {
        const name = `host-${mode}`;
        await harness.page.goto(`/hosts/${mode}/`);
        const input = harness.page.getByRole("textbox", { name: "Primary source", exact: true });
        await input.waitFor();
        await input.press("Control+End");
        await input.pressSequentially(" demo");
        await harness.page.waitForFunction(() => window.hostFixture.settled);
        assert.equal(await harness.page.evaluate(() => window.hostFixture.range(0, 10)), "start demo");
        await harness.page.screenshot({ path: `artifacts/inspect/${name}.png`, fullPage: true });
        await writeFile(`artifacts/inspect/${name}.json`, JSON.stringify(
            await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
    }
    {
        await harness.page.goto("/hosts/plain/");
        const input = harness.page.getByRole("textbox", { name: "Primary source", exact: true });
        await input.press("End"); await input.pressSequentially(" local correction");
        await harness.page.getByRole("button", { name: "Save source", exact: true }).click();
        await harness.page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
        await harness.page.evaluate(() => { window.hostFixture.externalWrite("remote source\r\n"); window.hostFixture.finishSave(); });
        await harness.page.getByRole("region", { name: "Save conflict", exact: true }).waitFor();
        await harness.page.getByRole("button", { name: "Review remote source", exact: true }).click();
        await input.press("End"); await input.pressSequentially(" during review");
        await harness.page.evaluate(() => window.hostFixture.finishConflictReview());
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return s.bindings.comparison?.status === "ready"
            && !s.bindings.comparison.workingViewport.pending && s.bindings.comparison.referenceViewport && !s.bindings.comparison.referenceViewport.pending; });
        if (await harness.page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length)) !== "start local correction during review" || await harness.page.evaluate(() => window.hostFixture.referenceRange(0, 15)) !== "remote source\r\n") throw new Error("Conflict inspection lost local or remote text.");
        if (!await input.evaluate(node => node.ownerDocument.activeElement === node)) throw new Error("Conflict review lost editing focus.");
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-save-conflict.png`, fullPage: true });
        await writeFile(`artifacts/inspect/host-plain-save-conflict.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await harness.page.getByRole("button", { name: "Save reviewed source", exact: true }).click();
        await input.press("End"); await input.pressSequentially(" later"); await harness.page.evaluate(() => window.hostFixture.finishSave());
        await harness.page.waitForFunction(() => window.hostFixture.snapshot().source.serverVersion === "v2");
        if (await harness.page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length)) !== "start local correction during review later") throw new Error("Reviewed save overwrote later typing.");
        await writeFile(`artifacts/inspect/host-plain-conflict-saved.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await harness.page.evaluate(() => window.hostFixture.dispose());
    }
    {
        await harness.page.goto("/hosts/plain/");
        const input = harness.page.getByRole("textbox", { name: "Primary source", exact: true });
        await input.fill("const saMORE = 123; // TODO\n😀 const value = 2;");
        await harness.page.waitForFunction(() => window.hostFixture.snapshot().bindings.language.sessions
            .some(session => session.id === "primary" && session.provider.connected));
        await harness.page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "plain" }));
        await harness.page.getByRole("button", { name: "Open source review", exact: true }).click();
        await input.press("Control+Home"); for (let i = 0; i < 8; i++) await input.press("ArrowRight");
        await input.press("Control+Space"); await harness.page.getByRole("option", { name: "sample", exact: true }).waitFor();
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return s.bindings.comparison?.status === "ready" && !s.bindings.comparison.workingViewport.pending
            && s.bindings.views.every(v => !v.metrics.viewport.pending); });
        if (await harness.page.locator('[aria-label="Left host pane"] .st-diagnostic').textContent() !== "TODO") throw new Error("Host inspection missed provider diagnostics.");
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-language.png`, fullPage: true });
        await writeFile(`artifacts/inspect/host-plain-language.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await input.press("Alt+Enter"); await input.press("Control+f");
        await harness.page.getByRole("checkbox", { name: "Match case", exact: true }).uncheck();
        await harness.page.getByRole("textbox", { name: "Find source", exact: true }).fill("todo");
        await harness.page.waitForFunction(() => document.querySelector('[aria-label="Find status"]')?.textContent?.includes("1 matches · ready"));
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-find.png`, fullPage: true });
        if (await harness.page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length)) !== "const sample = 123; // TODO\n😀 const value = 2;") throw new Error("Host inspection lost completion correction.");
        await harness.page.getByRole("textbox", { name: "Find source", exact: true }).press("Enter");
        const copied = await input.evaluate(node => { const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); node.dispatchEvent(event);
            if (!event.clipboardData) throw new Error("Inspection expected synthetic clipboard data."); return event.clipboardData.getData("text/plain"); });
        if (copied !== "TODO") throw new Error("Host command inspection copied the wrong range.");
        await input.evaluate(node => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            if (!event.clipboardData) throw new Error("Inspection expected synthetic clipboard data."); event.clipboardData.setData("text/plain", "A\r\nB"); node.dispatchEvent(event); });
        await harness.page.getByRole("button", { name: "Save source", exact: true }).click();
        await harness.page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
        await input.press("Control+End"); await input.pressSequentially(" later"); await harness.page.evaluate(() => window.hostFixture.finishSave());
        await harness.page.waitForFunction(() => window.hostFixture.snapshot().source.serverVersion === "v1");
        assert.equal(await harness.page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length)),
            "const sample = 123; // A\nB\n😀 const value = 2; later", "Pasted text follows the local LF ending and saving preserves later typing.");
        const retainedSelection = await harness.page.evaluate(() => window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")?.selection);
        assert.ok(retainedSelection, "Inspection expected the primary source selection.");
        await input.press("Escape"); await input.press("Tab");
        const form = harness.page.getByRole("textbox", { name: "Configuration path", exact: true });
        if (!await form.evaluate(node => node.ownerDocument.activeElement === node)) throw new Error("Host command inspection trapped keyboard focus.");
        await form.press("Shift+Tab");
        if (!await input.evaluate(node => node.ownerDocument.activeElement === node)
            || JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")?.selection)) !== JSON.stringify(retainedSelection)) throw new Error("Host command inspection lost the retained selection on focus return.");
        await input.press("Escape"); await input.press("Tab");
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return s.bindings.comparison?.status === "ready" && !s.bindings.comparison.workingViewport.pending
            && s.bindings.comparison.referenceViewport && !s.bindings.comparison.referenceViewport.pending; });
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-commands.png`, fullPage: true });
        await writeFile(`artifacts/inspect/host-plain-commands.json`, JSON.stringify({ state: await harness.page.evaluate(() => window.hostFixture.snapshot()), syntheticClipboard: { copied, pastedUnits: 4 }, physicalClipboardQualified: false }, null, 2));
        await input.focus(); await input.press("Control+Home"); await input.press("ArrowRight"); await input.press("ArrowRight");
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return s.bindings.views.every(v => !v.metrics.pendingCaret && !v.metrics.viewport.pending); });
        await harness.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await input.press("Control+k"); await input.press("Control+i");
        const popup = harness.page.getByRole("tooltip"); await popup.filter({ hasText: "Declares a constant binding." }).waitFor();
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-hover.png` });
        if (!await popup.isVisible() || !await input.evaluate(node => node.ownerDocument.activeElement === node)) throw new Error("Hover inspection lost presentation or source focus.");
        await writeFile(`artifacts/inspect/host-plain-hover.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await input.press("Escape"); await input.press("Control+f");
        await harness.page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
        const regexQuery = harness.page.getByRole("textbox", { name: "Find source", exact: true });
        await regexQuery.fill("(?<keyword>const)");
        await harness.page.waitForFunction(() => document.querySelector('[aria-label="Find status"]')?.textContent?.includes("2 matches · ready"));
        await harness.page.getByRole("textbox", { name: "Replacement", exact: true }).fill("$<keyword>_review");
        await harness.page.getByRole("button", { name: "Replace all", exact: true }).click();
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return document.querySelector('[aria-label="Find status"]')?.textContent?.includes("Replaced 2 matches.")
            && s.bindings.comparison?.status === "ready" && !s.bindings.comparison.workingViewport.pending && s.bindings.views.every(v => !v.metrics.viewport.pending); });
        if (await harness.page.evaluate(() => window.hostFixture.range(0, 12)) !== "const_review") throw new Error("Regex inspection lost native capture substitution.");
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-regex.png`, fullPage: true });
        await writeFile(`artifacts/inspect/host-plain-regex.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await regexQuery.fill("("); await harness.page.waitForFunction(() => document.querySelector('[aria-label="Find status"]')?.textContent?.includes("Invalid regular expression"));
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-regex-error.png`, fullPage: true });
        await harness.page.evaluate(() => window.hostFixture.dispose());
    }
    {
        await harness.page.goto("/hosts/plain/");
        await harness.page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "header\r\nhidden one\r\nhidden two\r\nfooter" }]); });
        await harness.page.getByRole("button", { name: "Open source review", exact: true }).click();
        await harness.page.getByRole("textbox", { name: "Primary source", exact: true }).focus();
        await harness.page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 32 }]); });
        await harness.page.getByRole("button", { name: "Fold selected lines", exact: true }).click();
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(), p = s.bindings.views.find(v => v.id === "primary"), c = s.bindings.comparison;
            return p?.metrics && p.metrics.viewport.visibleLines === 2 && !p.metrics.viewport.pending && c?.status === "ready" && !c.workingViewport.pending
                && c.referenceViewport && !c.referenceViewport.pending; });
        const disclosure = harness.page.getByRole("button", { name: "Expand lines 2–3", exact: true }); await disclosure.focus();
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-folding.png`, fullPage: true });
        await writeFile(`artifacts/inspect/host-plain-folding.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await harness.page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check();
        const tableInput = harness.page.getByRole("textbox", { name: "Primary source", exact: true }); await tableInput.focus();
        await harness.page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: f.snapshot().source.length }]); });
        await tableInput.evaluate(node => { const data = new DataTransfer(); data.setData("text/plain", "unused\tfallback"); data.setData("text/html", '<table><tr><th>city</th><th>value</th></tr><tr><td>東京</td><td>A,&quot;B&quot;</td></tr></table>');
            node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
        await harness.page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return s.bindings.tablePaste.status === "applied" && s.bindings.comparison?.status === "ready"
            && s.bindings.views.every(v => !v.metrics.viewport.pending) && !s.bindings.comparison.workingViewport.pending; });
        const csv = '"city","value"\r\n"東京","A,""B"""';
        if (await harness.page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length)) !== csv) throw new Error("Table paste inspection lost exact quoted CSV.");
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-table-paste.png`, fullPage: true });
        await writeFile(`artifacts/inspect/host-plain-table-paste.json`, JSON.stringify(await harness.page.evaluate(() => window.hostFixture.snapshot()), null, 2));
        await tableInput.evaluate(node => { const data = new DataTransfer(); data.setData("text/plain", "a\tb\nc"); node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
        await harness.page.waitForFunction(() => window.hostFixture.snapshot().bindings.tablePaste.status === "failed");
        if (await harness.page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length)) !== csv) throw new Error("Failed table paste altered the source.");
        await harness.page.screenshot({ path: `artifacts/inspect/host-plain-table-paste-error.png`, fullPage: true });
        await harness.page.evaluate(() => window.hostFixture.dispose());
    }
    await harness.page.goto("/viewport/");
    await harness.page.waitForFunction(() => { const state = window.viewportFixture?.snapshot(); return state && state.primary.revision !== null && !state.primary.pending; });
    await harness.page.screenshot({ path: "artifacts/inspect/viewport-lines.png", fullPage: true });
    await harness.page.evaluate(() => { window.viewportFixture.load("single-line"); window.viewportFixture.reveal("primary", window.viewportFixture.snapshot().document?.length ?? 0); });
    await harness.page.waitForFunction(() => !window.viewportFixture.snapshot().primary.pending && window.viewportFixture.snapshot().primary.scrollLeft > 1_000_000);
    await harness.page.screenshot({ path: "artifacts/inspect/viewport-long-line.png", fullPage: true });
    await writeFile("artifacts/inspect/viewport.json", JSON.stringify(await harness.page.evaluate(() => window.viewportFixture.snapshot()), null, 2));
    await harness.page.goto("/editing/");
    await harness.page.waitForFunction(() => window.editingFixture?.ready && !window.editingFixture.snapshot().primary.viewport.pending);
    await harness.page.evaluate(() => { window.editingFixture.select("primary", { anchor: 120_000, head: 120_000 }); window.editingFixture.focus("primary"); });
    await harness.page.keyboard.type("hello");
    await harness.page.waitForFunction(() => { const s = window.editingFixture.snapshot(); return !s.primary.viewport.pending && s.document && s.primary.viewport.revision === s.document.revision; });
    if (await harness.page.evaluate(() => window.editingFixture.range(120_000, 120_005)) !== "hello") throw new Error("Editor inspection missed actual keyboard input.");
    await harness.page.screenshot({ path: "artifacts/inspect/editing-lines.png", fullPage: true });
    await writeFile("artifacts/inspect/editing.json", JSON.stringify(await harness.page.evaluate(() => window.editingFixture.snapshot()), null, 2));
    await harness.page.evaluate(() => window.editingFixture.setText("😀 const sample = 123; // TODO"));
    await harness.page.getByRole("textbox", { name: "Find", exact: true }).fill("sample");
    await harness.page.waitForFunction(() => { const s = window.editingFixture.snapshot(); return s.find.status === "ready" && s.find.count === 1 && !s.primary.viewport.pending; });
    if (await harness.page.locator("#primary .st-search-match").textContent() !== "sample") throw new Error("Inspection missed highlighted search result.");
    await harness.page.screenshot({ path: "artifacts/inspect/editing-find.png", fullPage: true });
    await writeFile("artifacts/inspect/editing-services.json", JSON.stringify(await harness.page.evaluate(() => window.editingFixture.snapshot()), null, 2));
    await harness.page.evaluate(() => {
        window.editingFixture.setText(Array.from({ length: 60 }, (_, i) => `step ${String(i).padStart(2, "0")}\t東京 é 👩‍💻  alpha_beta.gamma`).join("\r\n"));
        window.editingFixture.select("primary", { anchor: 8, head: 8 }); window.editingFixture.focus("primary");
    });
    await harness.page.waitForFunction(() => !window.editingFixture.snapshot().primary.viewport.pending);
    await harness.page.keyboard.press("PageDown");
    await harness.page.waitForFunction(() => !window.editingFixture.snapshot().primary.viewport.pending);
    await harness.page.keyboard.press("Control+Shift+ArrowRight");
    await harness.page.waitForFunction(() => { const s = window.editingFixture.snapshot(); return !s.primary.viewport.pending; });
    await harness.page.screenshot({ path: "artifacts/inspect/editing-navigation.png", fullPage: true });
    await writeFile("artifacts/inspect/editing-navigation.json", JSON.stringify(await harness.page.evaluate(() => window.editingFixture.snapshot()), null, 2));
    await harness.page.evaluate(() => { const text = "x" + "\u0301".repeat(90_000) + "\n🇦🇧 👩‍💻"; window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: 90_001, head: 90_001 }); window.editingFixture.focus("primary"); });
    await harness.page.keyboard.press("Backspace");
    await harness.page.waitForFunction(() => { const s = window.editingFixture.snapshot(); return !s.primary.viewport.pending && s.document?.length === 11; });
    await harness.page.screenshot({ path: "artifacts/inspect/editing-graphemes.png", fullPage: true });
    await writeFile("artifacts/inspect/editing-graphemes.json", JSON.stringify(await harness.page.evaluate(() => window.editingFixture.snapshot()), null, 2));
    await harness.page.goto("/comparison/");
    await harness.page.waitForFunction(() => { const s = window.comparisonFixture?.snapshot(); return s && s.status === "ready" && !s.editor.viewport.pending && !s.reference?.pending; });
    await harness.page.getByRole("button", { name: "Next change", exact: true }).click();
    await harness.page.screenshot({ path: "artifacts/inspect/comparison.png", fullPage: true });
    await harness.page.evaluate(() => { window.comparisonFixture.setText("a\n"); window.comparisonFixture.begin("accept"); window.comparisonFixture.finish("accept"); window.comparisonFixture.setText("a\r\n"); });
    await harness.page.waitForFunction(() => window.comparisonFixture.snapshot().status === "ready");
    await harness.page.getByRole("button", { name: "Next change", exact: true }).click();
    await harness.page.screenshot({ path: "artifacts/inspect/comparison-whitespace.png", fullPage: true });
    await writeFile("artifacts/inspect/comparison.json", JSON.stringify(await harness.page.evaluate(() => window.comparisonFixture.snapshot()), null, 2));
    if (harness.errors.length) throw new Error(harness.errors.join("\n"));
    console.log("Wrote screenshots and fixture snapshots to artifacts/inspect/");
} finally { await harness.close(); }
}
await inspect();
