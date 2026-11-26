import { attachEditorLanguage, type Outcome, type TextEditor } from "sttropez/browser";
import type { LspWorkspace } from "sttropez/protocol";

export function bindLanguage(editor: TextEditor, provider: LspWorkspace) {
    const result = document.querySelector<HTMLOutputElement>("#result")!;
    const choices = document.querySelector<HTMLElement>("#choices")!;
    const problems = document.querySelector<HTMLElement>("#diagnostics")!;
    const language = attachEditorLanguage(editor, provider, {
        completion: { autoConnect: false, automatic: false, list: true }, diagnostics: { autoConnect: false },
        hover: { popup: true }, signature: { popup: true }, occurrences: {}, links: { paint: true },
        navigation: { chooser: {
            fileLabel: at => at.document.documentId === editor.view.documentId ? editor.workspace.document(editor.view.documentId).title : at.document.uri,
            capture: kind => at => {
                if (at.document.documentId !== editor.view.documentId) { result.value = at.document.uri; return; }
                editor.reveal({ from: at.from, to: kind === "definition" ? at.from : at.to },
                    { select: true, focus: true, align: "center-if-outside", expectedRevision: at.document.revision });
            },
        } },
        colors: { picker: true }, rename: { popup: { onNotice: message => { result.value = message; } } }, codeActions: { popup: true }, commands: {},
    });
    const events = new AbortController();
    let intent = 0;
    let offeredCommandVersion: number | undefined;
    let stopLinkList: (() => void) | undefined;
    function clear() {
        stopLinkList?.();
        stopLinkList = undefined;
        offeredCommandVersion = undefined;
        choices.replaceChildren();
        result.value = "";
    }
    const stopProvider = provider.subscribe(() => {
        const state = provider.getSnapshot();
        if (state.phase !== "ready" || offeredCommandVersion !== undefined
            && (!state.commandAvailable || state.registrationVersion("workspace/executeCommand") !== offeredCommandVersion)) {
            intent++;
            clear();
        }
    });
    function button(label: string, invoke: () => void) {
        const item = document.createElement("button");
        item.textContent = label;
        item.onpointerdown = event => event.preventDefault();
        item.onclick = () => { if (item.isConnected) invoke(); };
        return item;
    }
    function beginCommand(target: HTMLElement | TextEditor = editor) {
        clear();
        target.focus();
        return ++intent;
    }
    function command(id: string, run: (request: number) => void) {
        const control = document.getElementById(id)!;
        control.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
        control.addEventListener("click", () => run(beginCommand()), { signal: events.signal });
    }
    function display<T>(request: number, outcome: Outcome<T>, render: (value: T) => void) {
        if (request !== intent || events.signal.aborted) return;
        if (outcome.status === "done") render(outcome.value);
        else if (outcome.status === "failed") result.value = String(outcome.error);
        else result.value = outcome.status === "stale" ? "Request cancelled." : outcome.reason;
    }
    function renderDiagnostics() {
        problems.replaceChildren(...language.diagnostics.getSnapshot().diagnostics.map(item =>
            button(item.message, () => { item.select(); })));
    }
    const stopDiagnostics = language.diagnostics.subscribe(renderDiagnostics);
    const stopRename = language.rename.subscribe(() => {
        if (language.rename.getSnapshot().status === "applied") result.value = "Renamed";
    });
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
    command("definition", () => { editor.commands.run("locations.definition"); });
    command("references", () => { editor.commands.run("locations.references"); });
    command("rename", () => { editor.commands.run("rename.start"); });
    command("actions", () => { editor.commands.run("quickfix.show"); });
    command("links", async request => {
        display(request, await language.links.request(), links => {
            if (!links.length) {
                result.value = "No document links.";
                return;
            }
            const rows = links.map((_, index) => button("", async () => {
                const link = language.links.getSnapshot().links[index];
                if (link) display(request, await link.open(() => {}), uri => { result.value = uri; });
            }));
            function renderLinks() {
                const current = language.links.getSnapshot().links;
                if (!current.length) {
                    clear();
                    return;
                }
                current.forEach((link, index) => {
                    rows[index]!.textContent = link.tooltip || link.target || "Resolve link";
                });
            }
            choices.append(...rows);
            stopLinkList = language.links.subscribe(renderLinks);
            renderLinks();
        });
    });
    const runCommand = document.getElementById("command")!;
    runCommand.addEventListener("click", () => {
        beginCommand(runCommand);
        offeredCommandVersion = provider.getSnapshot().registrationVersion("workspace/executeCommand");
        const names = provider.commandNames();
        if (!names.length) result.value = "No advertised commands.";
        for (const name of names) choices.append(button(name, async () => {
            const request = beginCommand();
            display(request, await language.commands.run(name), () => { result.value = "Command completed"; });
        }));
    }, { signal: events.signal });
    return () => {
        events.abort();
        stopProvider();
        stopDiagnostics();
        stopRename();
        stopEdits();
        language.dispose();
        clear();
        problems.replaceChildren();
    };
}
