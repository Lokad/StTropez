import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const field = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const state = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const text = (page: Page) => page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
const snippet = (page: Page) => page.evaluate(() => window.hostFixture.providerState()?.snippet);
const view = async (page: Page) => (await state(page)).bindings.views.find(view => view.id === "primary")!;
const body = "${1|first\n\tline,second\n\tline|}\n$1\n${2:done}$0";

async function fixture(page: Page, mode: "plain" | "react", template = body) {
    let held = false, fieldOffers = false, release: (() => void) | undefined, capabilities: unknown;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer(); server.onMessage(message => client.send(message));
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (value.method === "initialize") capabilities = value.params.capabilities.textDocument.completion;
            if (value.method === "textDocument/completion") {
                if (fieldOffers) {
                    client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: [
                        { label: "entryName", insertTextFormat: 2, insertText: "${1:entry}Name$0" },
                    ] })); return;
                }
                const end = value.params.position, start = { line: end.line, character: end.character - 2 };
                client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { isIncomplete: false,
                    itemDefaults: { insertTextFormat: 2, editRange: { start, end } }, items: [{ label: "Context snippet", textEditText: "provisional" }] } })); return;
            }
            if (value.method === "completionItem/resolve") {
                const entry = value.params.label === "entryName";
                const response = JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { ...value.params,
                    ...(entry ? {} : { textEdit: { ...value.params.textEdit, newText: template } }),
                    additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: entry ? "// import\n" : "// shared\n" }] } });
                if (held) release = () => client.send(response); else client.send(response); return;
            }
            server.send(message);
        });
    });
    await page.goto(`/hosts/${mode}/?editor=candidate&language=lsp`); await expect(field(page)).toBeVisible(); await field(page).focus(); await ready(page);
    await expect.poll(async () => (await state(page)).bindings.language.sessions.find(session => session.id === "primary")!.provider.connected).toBe(true);
    await page.evaluate(() => window.hostFixture.providerCustom("fixture/completionStyle", { style: "interactive" }));
    expect(capabilities).toMatchObject({ insertTextMode: 2, completionItem: { insertTextModeSupport: { valueSet: [1, 2] } } });
    return { offerField: () => { fieldOffers = true; }, hold: () => { held = true; }, waiting: () => !!release, release: () => { held = false; release!(); release = undefined; } };
}

async function seed(page: Page, source: string, positions: readonly number[], primary = positions.length - 1) {
    await page.evaluate(({ source, positions, primary }) => {
        const f = window.hostFixture, state = f.snapshot(); f.editSource(state.source.revision, [{ from: 0, to: state.source.length, insert: source }]);
        if (!f.configureSource("primary", { tabSize: 4, insertSpaces: true, enter: "keep" })) throw new Error("Editor configuration failed.");
        if (!f.selectSourceSet("primary", f.snapshot().source.revision, positions.map(head => ({ anchor: head, head })), primary)) throw new Error("Caret capture failed.");
    }, { source, positions, primary });
    await field(page).focus(); await ready(page);
}
async function offer(page: Page) {
    await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "Context snippet", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.hostFixture.providerState()?.pending)).toBe(false);
}

test("dismissing and accepting completions in a linked field preserves the next field", async ({ page }) => {
    const peer = await fixture(page, "plain", "${1:name} = ${2:value}; $1$0");
    const input = field(page), item = page.getByRole("option", { name: "entryName", exact: true });
    await seed(page, "  sn", [4]); await offer(page); await input.press("Tab");
    await expect.poll(() => snippet(page)).toMatchObject({ stop: 1 });
    peer.offerField();
    await input.press("Control+Space"); await expect(item).toBeVisible(); await input.press("Escape");
    expect(await snippet(page)).toMatchObject({ stop: 1 });
    await input.pressSequentially("ent"); await expect(item).toBeVisible();
    expect(await text(page)).toBe("// shared\n  ent = value; ent");
    await input.press("Enter");
    await expect.poll(() => text(page)).toBe("// import\n// shared\n  entryName = value; entryName");
    expect(await snippet(page)).toMatchObject({ stop: 1 });
    peer.hold(); await input.press("Control+Space"); await expect.poll(peer.waiting).toBe(true);
    await input.press("Tab"); peer.release();
    await expect.poll(() => snippet(page)).toMatchObject({ stop: 2 }); await expect(item).toBeHidden();
    await input.pressSequentially("42");
    expect(await text(page)).toBe("// import\n// shared\n  entryName = 42; entryName");
    await input.press("Control+z"); await input.press("Control+z");
    expect(await text(page)).toBe("// shared\n  ent = value; ent");
});

test.describe(`plain contextual completion`, () => {
    test("nested multicaret snippets preserve choices, mirrored Enter, primary traversal and atomic history", async ({ page }) => {
        await fixture(page, "plain");
        const initial = "function outer() {\r\n    sn\r\n    if (true) {\r\n        sn\r\n    }\r\n}\r\n";
        const positions = [initial.indexOf("sn") + 2, initial.lastIndexOf("sn") + 2]; await seed(page, initial, positions);
        const before = (await view(page)).selectionSet, depth = (await state(page)).history.undoDepth;
        await offer(page); await field(page).press("Tab"); await ready(page);
        const expansion = (columns: number, choice: string) => `${choice}\r\n${" ".repeat(columns + 4)}line\r\n${" ".repeat(columns)}${choice}\r\n${" ".repeat(columns + 4)}line\r\n${" ".repeat(columns)}done`;
        const accepted = "// shared\n" + initial.replace("    sn", "    " + expansion(4, "first")).replace("        sn", "        " + expansion(8, "first"));
        expect(await text(page)).toBe(accepted); expect((await state(page)).history.undoDepth).toBe(depth + 1);
        expect((await view(page)).selectionSet).toMatchObject({ primary: 2, ranges: [{}, {}, {}, {}] });
        await field(page).press("ArrowRight"); await offer(page);
        expect((await view(page)).selectionSet).toMatchObject({ primary: 2, ranges: [{}, {}, {}, {}] });
        await field(page).press("Escape"); expect(await text(page)).toBe(accepted);
        await field(page).press("Control+z"); await ready(page); expect(await text(page)).toBe(initial); expect((await view(page)).selectionSet).toEqual(before);
        await field(page).press("Control+Shift+z"); await ready(page); expect(await text(page)).toBe(accepted); expect(await snippet(page)).toBeNull();
        await field(page).press("Control+z"); await ready(page); await offer(page); await field(page).press("Tab"); await ready(page);
        expect(await snippet(page)).toMatchObject({ stop: 1, choiceIndex: 0 });
        await field(page).press("Alt+ArrowDown"); await ready(page); expect(await text(page)).toBe(accepted.replaceAll("first", "second"));
        expect(await snippet(page)).toMatchObject({ stop: 1, choiceIndex: 1 });
        await field(page).press("Backspace"); await ready(page);
        expect(await text(page)).toBe(accepted.replaceAll("first", "second").replaceAll("line", "lin"));
        await field(page).pressSequentially("e"); await field(page).press("Enter"); await field(page).pressSequentially("tail"); await ready(page);
        const edited = await text(page); expect(edited.match(/tail/g)).toHaveLength(4); expect(edited).toContain("            line\r\n            tail");
        expect(edited).toContain("        line\r\n        tail"); expect(await snippet(page)).toMatchObject({ stop: 1 });
        await field(page).press("Tab"); await ready(page); expect(await snippet(page)).toMatchObject({ stop: 2, choiceIndex: -1 });
        expect((await view(page)).selectionSet).toMatchObject({ primary: 1, ranges: [{}, {}] });
        await field(page).press("Shift+Tab"); await ready(page); expect((await view(page)).selectionSet.primary).toBe(2);
        await field(page).press("Tab"); await field(page).press("Tab"); await ready(page);
        expect(await snippet(page)).toBeNull(); expect((await view(page)).selectionSet).toMatchObject({ primary: 1, ranges: [{}, {}] });
    });

    test("changed indentation expires held resolution and an incompatible secondary caret changes no text", async ({ page }) => {
        const peer = await fixture(page, "plain"), initial = "    xx\r\n        sn\r\n";
        await seed(page, initial, [initial.indexOf("sn") + 2]); peer.hold();
        await field(page).press("Control+Space"); await expect.poll(peer.waiting).toBe(true);
        await page.evaluate(() => window.hostFixture.configureSource("primary", { tabSize: 2, insertSpaces: false, enter: "keep" }));
        peer.release(); await expect.poll(() => page.evaluate(() => window.hostFixture.providerState()?.pending)).toBe(false);
        expect(await text(page)).toBe(initial); await expect(page.getByRole("option", { name: "Context snippet", exact: true })).toHaveCount(0);
        await seed(page, initial, [initial.indexOf("xx") + 2, initial.indexOf("sn") + 2]); const depth = (await state(page)).history.undoDepth;
        await offer(page); await field(page).press("Tab"); await ready(page);
        expect(await text(page)).toBe(initial); expect((await state(page)).history.undoDepth).toBe(depth);
        await expect(page.getByRole("option", { name: "Context snippet", exact: true })).toHaveCount(0);
    });
});
