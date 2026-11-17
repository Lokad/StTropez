import { tokenizeLine } from "../../fixtures/language/provider.ts";
import "./probe.css";
import { mountWorkspaceProbe } from "./workspace.ts";

type InputEventRecord = Readonly<{ surface: string; type: string; inputType: string | undefined;
    composing: boolean | undefined; trusted: boolean; selection: readonly [number, number] | null }>;
const events: InputEventRecord[] = [];
for (const element of document.querySelectorAll<HTMLTextAreaElement | HTMLDivElement>("textarea, [contenteditable]")) {
    for (const type of ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
        element.addEventListener(type, event => {
            const inputEvent = event as InputEvent;
            const selection = element instanceof HTMLTextAreaElement
                ? [element.selectionStart, element.selectionEnd] as const
                : getSelection()?.rangeCount ? [getSelection()!.anchorOffset, getSelection()!.focusOffset] as const : null;
            events.push(Object.freeze({ surface: element.getAttribute("aria-label")!, type,
                inputType: inputEvent.inputType, composing: inputEvent.isComposing, trusted: event.isTrusted, selection }));
            if (events.length > 200) events.shift();
        });
    }
}

const source = document.querySelector<HTMLTextAreaElement>('[aria-label="Tokenizer source"]')!;
const tokens = document.getElementById("tokens")!;
function highlight() {
    const nodes: Node[] = [];
    let cursor = 0;
    for (const token of tokenizeLine(source.value)) {
        nodes.push(document.createTextNode(source.value.slice(cursor, token.from)));
        const span = document.createElement("span");
        span.className = `token-${token.kind}`;
        span.textContent = source.value.slice(token.from, token.to);
        nodes.push(span);
        cursor = token.to;
    }
    nodes.push(document.createTextNode(source.value.slice(cursor)));
    tokens.replaceChildren(...nodes);
}
source.addEventListener("input", highlight);
let workspaceProbe: ReturnType<typeof mountWorkspaceProbe> | undefined;
document.getElementById("start-workspace")!.addEventListener("click", () => {
    workspaceProbe?.dispose(); workspaceProbe = mountWorkspaceProbe(document.getElementById("workspace")!);
});
document.getElementById("move-workspace")!.addEventListener("click", () => { workspaceProbe?.move(); });
document.getElementById("dispose-workspace")!.addEventListener("click", () => { workspaceProbe?.dispose(); });
window.addEventListener("pagehide", event => { if (!event.persisted) workspaceProbe?.dispose(); });
highlight();
const probe = { ready: true, events: () => [...events], workspace: () => workspaceProbe?.snapshot() };

declare global { interface Window { probe: typeof probe } }
window.probe = probe;
