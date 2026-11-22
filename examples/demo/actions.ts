import type { Workspace } from "../../src/index.ts";
import { createCodeActionController, mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { CodeActionPreview, TextEditor } from "../../src/browser/index.ts";
import type { LspCodeAction, LspWorkspace } from "../../src/protocol/index.ts";
import { HostProjectTools } from "../hosts/project.ts";
import { createReviewKey, pageActions, renderPanelActions, renderPanelButton } from "../hosts/panel-actions.ts";
import { actionChoicePageSize, actionEditPageSize, createActionPages } from "../hosts/action-pages.ts";
import { demoCommandPolicy } from "./action-commands.ts";
import { projectReviewNote } from "./action-fixture.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";
import { bindPopupCommands } from "./language-commands.ts";

/** Contextual presentation; the existing action controller owns captures, validation and history. */
export function mountDemoActions(scope: CleanupScope, workspace: Workspace, file: DemoFile, editor: TextEditor, provider: LspWorkspace,
    language: DemoLanguage, valid: () => boolean, dismissOther: () => void) {
    const events = new AbortController(); let disposed = false, commandAction = false;
    scope.defer(() => { disposed = true; events.abort(); });
    const popup = document.createElement("section"); scope.defer(() => popup.remove());
    popup.className = "demo-actions"; popup.hidden = true; popup.setAttribute("aria-label", "Quick fixes");
    const heading = document.createElement("h2"), status = document.createElement("p"), choices = document.createElement("div"), edits = document.createElement("ol"), close = document.createElement("button");
    const reviewKey = createReviewKey(workspace);
    let apply = document.createElement("button");
    heading.textContent = `Quick fixes in ${file.name}`; status.setAttribute("aria-label", "Quick-fix status"); edits.setAttribute("aria-label", "Quick-fix edits");
    apply.textContent = "Apply fix"; close.textContent = "Cancel fix"; apply.disabled = true;
    const pages = document.createElement("div"), choicePages = document.createElement("div"), choiceCount = document.createElement("span");
    let previousChoices = document.createElement("button"), nextChoices = document.createElement("button");
    choicePages.append(previousChoices, choiceCount, nextChoices);
    popup.append(heading, status, choices, choicePages, edits, pages, apply, close); document.body.append(popup);
    scope.defer(() => { apply.onclick = null; });
    const idle = () => { const state = editor.activity(); return !disposed && valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const present = (id: string) => id === file.resource.documentId && valid() ? editor : undefined;
    const commands = new HostProjectTools(workspace, () => idle(), present, undefined, provider, request =>
        request.edit.documents.length === 1 && request.edit.documents[0]!.target.document.documentId === file.resource.documentId
        && request.edit.documents[0]!.edits.length === 1 && request.edit.documents[0]!.edits.every(edit => edit.insert === projectReviewNote
            && edit.from === edit.to && edit.from === request.edit.documents[0]!.target.document.buffer.length) ? "apply" : "decline");
    scope.defer(() => commands.dispose());
    const tools = createCodeActionController(editor, provider, {
        documents: () => workspace.getSnapshot().documents.filter(doc => doc.language !== null), canCapture: idle,
        commandPolicy: demoCommandPolicy(file, () => workspace.document(file.resource.documentId).language?.uri, idle),
        prepareRequest: session => language.prepareActions(session, file),
        runCommand: command => commands.beginAction({ ...command, editor })
    });
    scope.defer(() => tools.dispose());
    // Host interaction policy only; all captures, permissions and history still pass through tools.
    const direct = (action: LspCodeAction) => {
        const changes = action.edit?.documents.filter(change => change.edits.length) ?? [];
        return (action.kind === "quickfix" || action.kind?.startsWith("quickfix.") === true) && !action.command
            && changes.length === 1 && changes[0]!.target.document.documentId === file.resource.documentId
            && changes[0]!.edits.length <= 4 && changes[0]!.edits.reduce((units, edit) => units + edit.to - edit.from + edit.insert.length, 0) <= 256;
    };
    const overlay = mountAnchoredOverlay(editor, popup, { onFocusedAnchorHidden: editor.focus });
    scope.defer(overlay.dispose);
    let open = false;
    const dismiss = () => { open = false; overlay.hide(); tools.cancel(); };
    const canApply = (preview: CodeActionPreview | null) =>
        !!preview?.canApply && (!preview.command || commands.canRunAction(editor));
    const anchor = () => {
        if (!open) return;
        const { revision, selection } = editor.view.getSnapshot();
        overlay.show({ revision, offset: selection.head, affinity: selection.headAffinity ?? "after" });
    };
    const request = () => {
        if (!idle()) return; dismissOther(); editor.focus();
        commandAction = false; open = true; anchor(); tools.request();
    };
    const readPages = createActionPages(tools, reviewKey, render);
    let oldChoices: unknown, oldChoicePage = -1;
    function render(): void {
        const state = tools.getSnapshot(), preview = state.preview;
        const { choicePage, choicePaging, editPaging, edits: page } = readPages();
        if (state.status === "ready") commandAction = !!preview?.command;
        status.textContent = state.status === "expired" ? "The code or selection changed. Request fixes again."
            : state.status === "ready" ? state.choices.length ? preview?.command ? state.message : "Choose a small fix to apply it. Broader changes stay here for review before Apply." : "No quick fix at this position."
                : state.message;
        if (oldChoices !== state.choices || oldChoicePage !== choicePage) {
            oldChoices = state.choices; oldChoicePage = choicePage; choices.replaceChildren(...state.choices.slice(choicePage * actionChoicePageSize, (choicePage + 1) * actionChoicePageSize).map(choice => {
                const button = document.createElement("button"); button.textContent = choice.title; button.disabled = choice.disabled !== null; button.title = choice.disabled ?? ""; button.dataset.choice = String(choice.index);
                button.addEventListener("click", () => choice.select(direct)); return button;
            }));
        }
        choicePages.hidden = state.choices.length <= actionChoicePageSize;
        const [back, forward] = pageActions("fixes", choicePaging);
        previousChoices = renderPanelButton(previousChoices, back); nextChoices = renderPanelButton(nextChoices, forward);
        choiceCount.textContent = `${choicePage * actionChoicePageSize + 1}–${Math.min((choicePage + 1) * actionChoicePageSize, state.choices.length)} of ${state.choices.length}`;
        for (const button of choices.querySelectorAll<HTMLButtonElement>("[data-choice]")) button.dataset.chosen = String(Number(button.dataset.choice) === state.choice);
        edits.start = (page?.page ?? 0) * actionEditPageSize + 1;
        edits.replaceChildren(...(page?.notes ?? []).map(at => {
            const item = document.createElement("li"), before = document.createElement("del"), after = document.createElement("ins");
            before.textContent = at.before ?? at.context; after.textContent = at.insert + ((at.insertUnits ?? at.insert.length) > at.insert.length ? "…" : "");
            item.append(`${at.title} `, before, " → ", after); return item;
        }));
        apply = renderPanelButton(apply, { label: preview?.command ? "Run action" : "Apply fix", reviewKey: reviewKey(preview),
            disabled: !canApply(preview), invoke: preview?.confirm ?? null });
        pages.hidden = !editPaging;
        renderPanelActions(pages, pageActions("edits", editPaging));
        if (state.status === "applied" && !commandAction) queueMicrotask(() => { if (!disposed && tools.getSnapshot() === state) { dismiss(); editor.focus(); } });
    }
    scope.defer(tools.subscribe(render));
    scope.defer(commands.state.subscribe(() => { if (tools.getSnapshot().preview?.command) render(); }));
    scope.defer(editor.view.subscribe(anchor));
    popup.addEventListener("pointerdown", event => { if (event.target === apply) event.preventDefault(); }, { signal: events.signal });
    choices.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    close.addEventListener("click", () => { dismiss(); editor.focus(); }, { signal: events.signal });
    const bind = bindPopupCommands(scope, editor, popup, 35);
    bind("quickfix.dismiss", "Dismiss quick fixes", "Escape", () => { dismiss(); editor.focus(); });
    bind("quickfix.apply", "Apply selected fix", "Enter", () => {
        const state = tools.getSnapshot();
        if (state.preview && canApply(state.preview)) { state.preview.confirm(); return true; }
        if (!["pending", "resolving", "executing"].includes(state.status)) dismiss();
        return false;
    });
    const move = (direction: -1 | 1) => {
        const state = tools.getSnapshot(), count = state.choices.length;
        const focused = choices.querySelector<HTMLElement>("[data-choice]:focus")?.dataset.choice;
        const start = focused === undefined ? state.choice ?? (direction === 1 ? -1 : 0) : Number(focused);
        for (let step = 1; step <= count; step++) {
            const next = state.choices[(start + direction * step + count) % count]!;
            if (next.disabled !== null) continue;
            editor.focus(); next.select(); return true;
        }
        return false;
    };
    bind("quickfix.previous", "Previous quick fix", "ArrowUp", () => move(-1));
    bind("quickfix.next", "Next quick fix", "ArrowDown", () => move(1));
    scope.defer(commands.attach("source", file.tab, editor));
    return Object.freeze({ request, dismiss, isOpen: () => !popup.hidden });
}
