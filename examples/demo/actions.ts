import type { Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { HostActionsTools } from "../hosts/code-actions.ts";
import { createLspActionClient } from "../editing/lsp-action-client.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";

/** Contextual presentation; the existing action controller owns captures, validation and history. */
export function mountDemoActions(workspace: Workspace, file: DemoFile, editor: EditingCandidate, provider: LspWorkspace,
    language: DemoLanguage, valid: () => boolean, dismissOther: () => void) {
    const events = new AbortController(), popup = document.createElement("section"); popup.className = "demo-actions"; popup.hidden = true; popup.setAttribute("aria-label", "Quick fixes");
    const heading = document.createElement("h2"), status = document.createElement("p"), choices = document.createElement("div"), edits = document.createElement("ol"), apply = document.createElement("button"), close = document.createElement("button");
    heading.textContent = `Quick fixes in ${file.name}`; status.setAttribute("aria-label", "Quick-fix status"); edits.setAttribute("aria-label", "Quick-fix edits");
    apply.textContent = "Apply fix"; close.textContent = "Cancel fix"; apply.disabled = true;
    const previous = document.createElement("button"), next = document.createElement("button"), pages = document.createElement("div"); previous.textContent = "Previous edits"; next.textContent = "Next edits"; pages.append(previous, next);
    const previousChoices = document.createElement("button"), nextChoices = document.createElement("button"), choicePages = document.createElement("div"), choiceCount = document.createElement("span");
    previousChoices.textContent = "Previous fixes"; nextChoices.textContent = "Next fixes"; choicePages.append(previousChoices, choiceCount, nextChoices);
    popup.append(heading, status, choices, choicePages, edits, pages, apply, close); document.body.append(popup);
    let disposed = false;
    const idle = () => { const state = editor.snapshot(); return !disposed && valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const tools = new HostActionsTools(workspace, () => idle(), id => id === file.resource.documentId && valid() ? editor : undefined,
        () => createLspActionClient({ provider, beforeRequest: session => language.prepareActions(session, file) }));
    const dismiss = () => { popup.hidden = true; tools.cancel(); };
    const position = () => {
        const point = editor.viewport.coordsAt(editor.view.getSnapshot().selection.head), box = editor.element.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(innerWidth - 400, point?.left ?? box.left + 8))}px`;
        popup.style.top = `${Math.max(8, Math.min(innerHeight - 290, point ? point.top + point.height + 6 : box.top + 8))}px`;
    };
    const request = () => {
        if (!idle()) return; dismissOther(); editor.focus(); position();
        popup.hidden = false; tools.begin("source");
    };
    let oldChoices: unknown, oldChoicePage = -1;
    const stop = tools.state.subscribe(() => {
        const state = tools.state.getSnapshot();
        if (!popup.hidden) position();
        status.textContent = state.pending ? "Finding quick fixes…" : state.status === "expired" ? "The code or selection changed. Request fixes again."
            : state.status === "failed" ? "Quick fixes are unavailable. Try again with current code." : state.status === "ready" ? state.choices.length ? "Choose a fix, review its changes, then apply." : "No quick fix at this position." : "Request a fix for the current error.";
        if (oldChoices !== state.choices || oldChoicePage !== state.choicePage) {
            oldChoices = state.choices; oldChoicePage = state.choicePage; choices.replaceChildren(...state.choices.slice(state.choicePage * 16, (state.choicePage + 1) * 16).map(choice => {
                const button = document.createElement("button"); button.textContent = choice.title; button.disabled = choice.disabled !== null; button.title = choice.disabled ?? ""; button.dataset.choice = String(choice.index);
                button.addEventListener("click", () => { if (tools.state.getSnapshot().token === state.token) tools.selectChoice(choice.index); }); return button;
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
        apply.disabled = !state.canApply; apply.onclick = () => tools.apply(state.token);
        pages.hidden = state.editCount <= 64; previous.disabled = state.page === 0; next.disabled = (state.page + 1) * 64 >= state.editCount;
        if (state.status === "applied") queueMicrotask(() => { if (!disposed && tools.state.getSnapshot() === state) { dismiss(); editor.focus(); } });
    });
    editor.element.addEventListener("sttropez-render", () => { if (!popup.hidden) position(); }, { signal: events.signal });
    apply.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    choices.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    close.addEventListener("click", () => { dismiss(); editor.focus(); }, { signal: events.signal });
    previous.addEventListener("click", () => tools.previousPage(), { signal: events.signal }); next.addEventListener("click", () => tools.nextPage(), { signal: events.signal });
    previousChoices.addEventListener("click", () => tools.moveChoicePage(-1), { signal: events.signal }); nextChoices.addEventListener("click", () => tools.moveChoicePage(1), { signal: events.signal });
    editor.input.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || editor.snapshot().composing) return;
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
    const detach = tools.attach("source", file.tab, editor);
    return Object.freeze({ request, dismiss, isOpen: () => !popup.hidden,
        destroy: () => { disposed = true; events.abort(); detach(); stop(); tools.dispose(); apply.onclick = null; popup.remove(); } });
}
