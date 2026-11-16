import { tokenizeLine } from "../../fixtures/language/provider.ts";
import type { ProviderInput, ProviderResult } from "../../fixtures/language/provider.ts";
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

const source = document.querySelector<HTMLTextAreaElement>('[aria-label="Provider source"]')!;
const tokens = document.getElementById("tokens")!;
const status = document.getElementById("provider-status")!;
const diagnostics = document.getElementById("diagnostics")!;
let revision = 0, sequence = 0, generation = 0, delay = 0, pending: ProviderInput | undefined;
let worker: Worker | undefined;
const counters = { posted: 0, received: 0, applied: 0, stale: 0, cancelled: 0, connections: 0 };

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
function connect() {
    worker?.terminate();
    pending = undefined;
    const epoch = ++generation;
    worker = new Worker("/provider-worker.js", { type: "module" });
    counters.connections++;
    worker.addEventListener("error", () => { status.textContent = "Provider failed; local editing remains available."; pending = undefined; });
    worker.addEventListener("message", (event: MessageEvent<string>) => {
        counters.received++;
        const result = JSON.parse(event.data) as ProviderResult;
        if (epoch !== generation || !pending || result.id !== pending.id || result.revision !== revision) {
            counters.stale++;
            if (pending?.id === result.id) { pending = undefined; status.textContent = "Stale result discarded."; }
            return;
        }
        pending = undefined;
        source.setRangeText(result.completion.insert, result.completion.from, result.completion.to, "end");
        revision++;
        counters.applied++;
        // Map diagnostics through this fixture's single completion replacement.
        const delta = result.completion.insert.length - (result.completion.to - result.completion.from);
        diagnostics.replaceChildren(...result.diagnostics.map(diagnostic => {
            const item = document.createElement("li");
            const from = diagnostic.from >= result.completion.to ? diagnostic.from + delta : diagnostic.from;
            item.textContent = `${from}: ${diagnostic.message}`;
            return item;
        }));
        highlight();
        status.textContent = "Completion and diagnostics applied.";
    });
    status.textContent = "Provider connected.";
}
source.addEventListener("input", () => { revision++; diagnostics.replaceChildren(); highlight(); });
document.getElementById("complete")!.addEventListener("click", () => {
    if (!worker) { status.textContent = "Provider unavailable; local editing remains available."; return; }
    pending = Object.freeze({ id: ++sequence, revision, text: source.value, offset: source.selectionStart, delay });
    counters.posted++;
    worker.postMessage(JSON.stringify(pending));
    status.textContent = "Request pending.";
});
document.getElementById("cancel")!.addEventListener("click", () => {
    if (pending) counters.cancelled++;
    pending = undefined;
    status.textContent = "Request cancelled.";
});
document.getElementById("disconnect")!.addEventListener("click", () => {
    worker?.terminate(); worker = undefined; pending = undefined; generation++;
    status.textContent = "Provider disconnected; local editing remains available.";
});
document.getElementById("reconnect")!.addEventListener("click", connect);
let workspaceProbe: ReturnType<typeof mountWorkspaceProbe> | undefined;
document.getElementById("start-workspace")!.addEventListener("click", () => {
    workspaceProbe?.dispose(); workspaceProbe = mountWorkspaceProbe(document.getElementById("workspace")!);
});
document.getElementById("move-workspace")!.addEventListener("click", () => { workspaceProbe?.move(); });
document.getElementById("dispose-workspace")!.addEventListener("click", () => { workspaceProbe?.dispose(); });
window.addEventListener("pagehide", event => { if (!event.persisted) { worker?.terminate(); workspaceProbe?.dispose(); } });
highlight(); connect();
const probe = { ready: true, events: () => [...events], counters: () => ({ ...counters }),
    setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1_000) throw new RangeError("Invalid delay."); delay = value; },
    revision: () => revision, workspace: () => workspaceProbe?.snapshot() };
declare global { interface Window { probe: typeof probe } }
window.probe = probe;
