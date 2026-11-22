import type { Locator } from "@playwright/test";

export async function moveEditorIntoShadow(source: Locator): Promise<void> {
    await source.evaluate(input => {
        const editor = input.closest<HTMLElement>(".st-editor")!, host = document.createElement("div");
        host.style.height = "200px"; editor.before(host);
        const root = host.attachShadow({ mode: "open" });
        for (const style of document.querySelectorAll("style, link[rel=stylesheet]")) root.append(style.cloneNode(true));
        root.append(editor);
    });
}
