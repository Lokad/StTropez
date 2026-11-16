import type { Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import type { LspCodeAction, LspWorkspace } from "../../src/protocol/index.ts";
import { HostActionsTools } from "../hosts/code-actions.ts";
import { HostProjectTools } from "../hosts/project.ts";
import { createLspActionClient } from "../shared/language/lsp-action-client.ts";
import { demoCommandPolicy } from "./action-commands.ts";
import { projectReviewNote } from "./action-fixture.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

/** Contextual presentation; the existing action controller owns captures, validation and history. */
export function mountDemoActions(scope: CleanupScope, workspace: Workspace, file: DemoFile, editor: EditingCandidate, provider: LspWorkspace,
    language: DemoLanguage, valid: () => boolean, dismissOther: () => void) {
    const events = new AbortController(); let disposed = false, commandAction = false;
    scope.defer(() => { disposed = true; events.abort(); });
    const popup = document.createElement("section"); scope.defer(() => popup.remove());
    popup.className = "demo-actions"; popup.hidden = true; popup.setAttribute("aria-label", "Quick fixes");
    const heading = document.createElement("h2"), status = document.createElement("p"), choices = document.createElement("div"), edits = document.createElement("ol"), apply = document.createElement("button"), close = document.createElement("button");
    heading.textContent = `Quick fixes in ${file.name}`; status.setAttribute("aria-label", "Quick-fix status"); edits.setAttribute("aria-label", "Quick-fix edits");
    apply.textContent = "Apply fix"; close.textContent = "Cancel fix"; apply.disabled = true;
    const previous = document.createElement("button"), next = document.createElement("button"), pages = document.createElement("div"); previous.textContent = "Previous edits"; next.textContent = "Next edits"; pages.append(previous, next);
    const previousChoices = document.createElement("button"), nextChoices = document.createElement("button"), choicePages = document.createElement("div"), choiceCount = document.createElement("span");
    previousChoices.textContent = "Previous fixes"; nextChoices.textContent = "Next fixes"; choicePages.append(previousChoices, choiceCount, nextChoices);
    popup.append(heading, status, choices, choicePages, edits, pages, apply, close); document.body.append(popup);
    scope.defer(() => { apply.onclick = null; });
    const idle = () => { const state = editor.activity(); return !disposed && valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const present = (id: string) => id === file.resource.documentId && valid() ? editor : undefined;
    const commands = new HostProjectTools(workspace, () => idle(), present, undefined, provider, request =>
        request.edit.documents.length === 1 && request.edit.documents[0]!.target.document.documentId === file.resource.documentId
        && request.edit.documents[0]!.edits.length === 1 && request.edit.documents[0]!.edits.every(edit => edit.insert === projectReviewNote
            && edit.from === edit.to && edit.from === request.edit.documents[0]!.target.document.buffer.length) ? "apply" : "decline");
    scope.defer(() => commands.dispose());
    const tools = new HostActionsTools(workspace, () => idle(), present,
        () => createLspActionClient({ provider, commandPolicy: demoCommandPolicy(file, () => language.documentUri(file), idle),
            beforeRequest: session => language.prepareActions(session, file) }), commands, provider);
    scope.defer(() => tools.dispose());
    // Host interaction policy only; all captures, permissions and history still pass through tools.
    const direct = (action: LspCodeAction) => {
        const changes = action.edit?.documents.filter(change => change.edits.length) ?? [];
        return (action.kind === "quickfix" || action.kind?.startsWith("quickfix.") === true) && !action.command
            && changes.length === 1 && changes[0]!.target.document.documentId === file.resource.documentId
            && changes[0]!.edits.length <= 4 && changes[0]!.edits.reduce((units, edit) => units + edit.to - edit.from + edit.insert.length, 0) <= 256;
    };
    const dismiss = () => { popup.hidden = true; tools.cancel(); };
    const position = () => {
        const point = editor.viewport.coordsAt(editor.view.getSnapshot().selection.head), box = editor.element.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(innerWidth - 400, point?.left ?? box.left + 8))}px`;
        popup.style.top = `${Math.max(8, Math.min(innerHeight - 290, point ? point.top + point.height + 6 : box.top + 8))}px`;
    };
    const request = () => {
        if (!idle()) return; dismissOther(); editor.focus(); position();
        commandAction = false; popup.hidden = false; tools.begin("source");
    };
    let oldChoices: unknown, oldChoicePage = -1;
    scope.defer(tools.state.subscribe(() => {
        const state = tools.state.getSnapshot();
        if (state.status === "ready") commandAction = state.command !== null;
        if (!popup.hidden) position();
        status.textContent = state.status === "expired" ? "The code or selection changed. Request fixes again."
            : state.status === "ready" ? state.choices.length ? state.command ? state.message : "Choose a small fix to apply it. Broader changes stay here for review before Apply." : "No quick fix at this position."
                : state.message;
        if (oldChoices !== state.choices || oldChoicePage !== state.choicePage) {
            oldChoices = state.choices; oldChoicePage = state.choicePage; choices.replaceChildren(...state.choices.slice(state.choicePage * 16, (state.choicePage + 1) * 16).map(choice => {
                const button = document.createElement("button"); button.textContent = choice.title; button.disabled = choice.disabled !== null; button.title = choice.disabled ?? ""; button.dataset.choice = String(choice.index);
                button.addEventListener("click", () => tools.activateChoice(choice.index, state.token, direct)); return button;
            }));
        }
        choicePages.hidden = state.choices.length <= 16; previousChoices.disabled = state.pending || state.choicePage === 0; nextChoices.disabled = state.pending || (state.choicePage + 1) * 16 >= state.choices.length;
        choiceCount.textContent = `${state.choicePage * 16 + 1}–${Math.min((state.choicePage + 1) * 16, state.choices.length)} of ${state.choices.length}`;
        for (const button of choices.querySelectorAll<HTMLButtonElement>("[data-choice]")) button.dataset.chosen = String(Number(button.dataset.choice) === state.choice);
        edits.replaceChildren(...state.edits.map(at => {
            const item = document.createElement("li"), before = document.createElement("del"), after = document.createElement("ins");
            before.textContent = at.before ?? at.context; after.textContent = at.insert + ((at.insertUnits ?? at.insert.length) > at.insert.length ? "…" : "");
            item.append(`${at.title} `, before, " → ", after); return item;
        }));
        const applyLabel = state.command ? "Run action" : "Apply fix"; if (apply.textContent !== applyLabel) apply.textContent = applyLabel;
        apply.disabled = !state.canApply; apply.onclick = () => tools.apply(state.token);
        pages.hidden = state.editCount <= 64; previous.disabled = state.page === 0; next.disabled = (state.page + 1) * 64 >= state.editCount;
        if (state.status === "applied" && !commandAction) queueMicrotask(() => { if (!disposed && tools.state.getSnapshot() === state) { dismiss(); editor.focus(); } });
    }));
    scope.defer(editor.viewport.onRender(() => { if (!popup.hidden) position(); }));
    apply.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    choices.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    close.addEventListener("click", () => { dismiss(); editor.focus(); }, { signal: events.signal });
    previous.addEventListener("click", () => tools.previousPage(), { signal: events.signal }); next.addEventListener("click", () => tools.nextPage(), { signal: events.signal });
    previousChoices.addEventListener("click", () => tools.moveChoicePage(-1), { signal: events.signal }); nextChoices.addEventListener("click", () => tools.moveChoicePage(1), { signal: events.signal });
    editor.input.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || editor.activity().composing) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ".") { event.preventDefault(); event.stopImmediatePropagation(); request(); }
        else if (!popup.hidden && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            const state = tools.state.getSnapshot();
            if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
            else if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); if (state.canApply) tools.apply(state.token); }
            else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && state.choices.length) {
                event.preventDefault(); event.stopImmediatePropagation(); tools.selectChoice(((state.choice ?? 0) + (event.key === "ArrowDown" ? 1 : state.choices.length - 1)) % state.choices.length);
            }
        }
    }, { capture: true, signal: events.signal });
    scope.defer(commands.attach("source", file.tab, editor));
    scope.defer(tools.attach("source", file.tab, editor));
    return Object.freeze({ request, dismiss, isOpen: () => !popup.hidden });
}
