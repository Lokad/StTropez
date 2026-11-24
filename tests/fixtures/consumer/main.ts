import { Workspace } from "sttropez";
import { createFindController, createRegexFindBackend, mountTextEditor } from "sttropez/browser";
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

const font = await new FontFace("ConsumerFixture", fontFixture()).load();
document.fonts.add(font);
editor.element.style.setProperty("--st-font", font.family);
window.addEventListener("pagehide", () => {
    find.dispose();
    editor.dispose();
    document.fonts.delete(font);
}, { once: true });
