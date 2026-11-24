import { Workspace } from "sttropez";
import { createFindController, createFontAssetController, createRegexFindBackend, mountTextEditor } from "sttropez/browser";
import "sttropez/protocol";
import "sttropez/kernels";
import { fontFixture } from "./font-fixture.js";

const workspace = new Workspace();
const documentId = workspace.createDocument({ scope: "consumer", resource: "sample", variant: "text" }, "Sample", "smoke");
const tab = workspace.tabs.open({ kind: "text", documentId }, "Sample");
const editor = mountTextEditor(document.querySelector<HTMLElement>("main")!, workspace, tab, { ariaLabel: "Sample" });
const find = createFindController(editor, {
    regularExpressionBackend: createRegexFindBackend({
        clock: window,
        createWorker: () => new Worker(import.meta.resolve("sttropez/regex-worker.js"), { type: "module" }),
    }),
});
const matches = document.querySelector<HTMLOutputElement>("#matches")!;
find.subscribe(() => {
    const search = find.getSnapshot();
    matches.value = search.status === "ready" ? String(search.count) : search.message;
});
find.setFlags({ regularExpression: true });
find.setQuery("sm.ke");

const font = createFontAssetController(document, "smoke-font");
const load = font.request(0, fontFixture());
if (!load) throw new Error("Font request was rejected");
const result = await load.settled;
document.querySelector<HTMLOutputElement>("#font")!.value = result.status;
window.addEventListener("pagehide", () => {
    find.dispose();
    editor.dispose();
    font.dispose();
}, { once: true });
