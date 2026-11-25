import { attachEditorLanguage, type Outcome, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function bindLanguage(editor: TextEditor, provider: LspWorkspace) {
    const result = document.querySelector<HTMLOutputElement>("#result")!;
    const choices = document.querySelector<HTMLElement>("#choices")!;
    const problems = document.querySelector<HTMLElement>("#diagnostics")!;
    const language = attachEditorLanguage(editor, provider, {
        completion: { autoConnect: false, automatic: false, list: true }, diagnostics: { autoConnect: false },
        hover: { popup: true }, signature: { popup: true }, navigation: {}, occurrences: {}, links: { paint: true },
        colors: { swatches: true }, rename: {}, codeActions: {}, commands: {},
    });
    const events = new AbortController();
    let intent = 0;
    function clear() {
        choices.replaceChildren();
        result.value = "";
    }
    function button(label: string, invoke: () => void) {
        const item = document.createElement("button");
        item.textContent = label;
        item.onpointerdown = event => event.preventDefault();
        item.onclick = invoke;
        return item;
    }
    function command(id: string, run: (request: number) => void) {
        const control = document.getElementById(id)!;
        control.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
        control.addEventListener("click", () => {
            clear();
            editor.focus();
            run(++intent);
        }, { signal: events.signal });
    }
    function display<T>(request: number, outcome: Outcome<T>, render: (value: T) => void) {
        if (request !== intent || events.signal.aborted) return;
        if (outcome.status === "done") render(outcome.value);
        else if (outcome.status === "failed") result.value = String(outcome.error);
        else result.value = outcome.status === "stale" ? "The source changed. Try again." : outcome.reason;
    }
    function renderDiagnostics() {
        problems.replaceChildren(...language.diagnostics.getSnapshot().diagnostics.map(item =>
            button(item.message, () => { item.select(); })));
    }
    const stopDiagnostics = language.diagnostics.subscribe(renderDiagnostics);
    const stopEdits = editor.workspace.onDocumentChange(editor.view.documentId, change => {
        // The language command reports its outcome after its refactor reaches this listener.
        if (change.origin !== "host" || change.kind !== "refactor") intent++;
        clear();
    });
    renderDiagnostics();
    command("complete", async request => {
        display(request, await language.completion.request(), state => {
            if (!state.choices.length) result.value = "No completions.";
        });
    });
    command("hover", async request => {
        display(request, await language.hover.request(), hover => { if (!hover.text) result.value = "No hover information."; });
    });
    command("signature", async request => {
        display(request, await language.signature.request(), help => { if (!help.signature) result.value = "No signature."; });
    });
    command("definition", async request => {
        display(request, await language.navigation.request("definition"), locations => {
            const choice = locations.locationAt(0);
            if (!choice) result.value = "No definition.";
            else choice.open(place => {
                if (place.document.documentId === editor.view.documentId) {
                    editor.reveal(place, { select: true, focus: true, align: "center-if-outside",
                        expectedRevision: place.document.revision });
                } else result.value = place.document.uri;
            });
        });
    });
    command("rename", async request => {
        const name = window.prompt("New symbol name");
        if (name) display(request, await language.rename.request(name), () => { result.value = "Renamed"; });
    });
    command("actions", async request => {
        display(request, await language.codeActions.request(), actions => {
            if (!actions.length) result.value = "No code actions here.";
            for (const action of actions) {
                const item = button(action.title, async () => {
                    display(request, await action.select(), () => { clear(); editor.focus(); });
                });
                item.disabled = action.disabled !== null;
                item.title = action.disabled ?? "";
                choices.append(item);
            }
        });
    });
    command("links", async request => {
        display(request, await language.links.request(), links => {
            if (!links.length) result.value = "No document links.";
            for (const link of links) {
                choices.append(button(link.tooltip || link.target || "Resolve link", async () => {
                    display(request, await link.open(() => {}), uri => { result.value = uri; });
                }));
            }
        });
    });
    command("command", request => {
        const scope = provider.createScope();
        try {
            const names = scope.commandNames();
            if (!names.length) result.value = "No advertised commands.";
            for (const name of names) choices.append(button(name, async () => {
                display(request, await language.commands.run(name), () => { result.value = "Command completed"; });
            }));
        } finally { scope.dispose(); }
    });
    return () => {
        events.abort();
        stopDiagnostics();
        stopEdits();
        language.dispose();
        clear();
        problems.replaceChildren();
    };
}
