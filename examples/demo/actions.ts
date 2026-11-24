import type { Workspace } from "../../src/index.ts";
import { mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { CodeActionChoice, CodeActionController, CodeActionControllerOptions, CodeActionPreview, TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { createReviewKey, pageActions, renderPanelActions, renderPanelButton } from "../hosts/panel-actions.ts";
import { actionChoicePageSize, createActionPages, requestActionsForReview } from "../hosts/action-pages.ts";
import { editPageSize } from "../hosts/edit-review.ts";
import { demoCommandPolicy } from "./action-commands.ts";
import { projectReviewNote } from "./action-fixture.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";
import { bindPopupCommands } from "./language-commands.ts";

export function demoActionPolicy(workspace: Workspace, file: DemoFile, language: DemoLanguage,
    valid: () => boolean): CodeActionControllerOptions {
    return {
        documents: () => workspace.getSnapshot().documents.filter(doc => doc.language !== null), canCapture: valid,
        commandPolicy: demoCommandPolicy(file, () => workspace.document(file.resource.documentId).language?.uri, valid),
        prepareRequest: session => language.prepareActions(session, file),
        reviewCommandEdit: ({ edit }) => {
            const part = edit.documents[0];
            if (edit.documents.length !== 1 || part?.target.document.documentId !== file.resource.documentId) return false;
            const note = part.edits[0];
            return part.edits.length === 1 && note?.insert === projectReviewNote
                && note.from === note.to && note.from === part.target.document.buffer.length;
        }
    };
}

/** Contextual presentation; the existing action controller owns captures, validation and history. */
export function mountDemoActions(scope: CleanupScope, workspace: Workspace, file: DemoFile, editor: TextEditor, tools: CodeActionController,
    provider: LspWorkspace, idle: () => boolean, dismissOther: () => void) {
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
    const body = document.createElement("div");
    body.className = "demo-action-body";
    body.append(status, choices, choicePages, edits, pages);
    const footer = document.createElement("div");
    footer.className = "demo-action-footer";
    footer.append(apply, close);
    popup.append(heading, body, footer);
    document.body.append(popup);
    scope.defer(() => { apply.onclick = null; });
    // Host interaction policy only; all captures, permissions and history still pass through tools.
    async function pick(choice: CodeActionChoice) {
        const result = await choice.select({ review: true });
        if (result.status !== "done" || !result.value.canApply || result.value.command) return;
        if (choice.kind !== "quickfix" && !choice.kind?.startsWith("quickfix.")) return;
        const edits = result.value.readEdits(0, 4);
        if (!edits || !edits.total || edits.total > 4) return;
        if (edits.notes.every(edit => edit.document === file.resource.documentId)
            && edits.notes.reduce((units, edit) => units + edit.to - edit.from + edit.insertUnits, 0) <= 256) {
            await result.value.apply();
        }
    }
    const overlay = mountAnchoredOverlay(editor, popup, { onFocusedAnchorHidden: editor.focus });
    scope.defer(overlay.dispose);
    let open = false;
    const hide = () => { open = false; overlay.hide(); };
    const dismiss = () => { hide(); tools.cancel(); };
    const canApply = (preview: CodeActionPreview | null) =>
        !!preview?.canApply && (!preview.command || provider.getSnapshot().commandAvailable);
    const anchor = () => {
        if (!open) return;
        const { revision, selection } = editor.view.getSnapshot();
        overlay.show({ revision, offset: selection.head, affinity: selection.headAffinity ?? "after" });
    };
    const request = () => {
        if (!idle()) return; dismissOther(); editor.focus();
        commandAction = false;
        open = true;
        anchor();
        void requestActionsForReview(tools);
    };
    const readPages = createActionPages(tools, reviewKey, render);
    let oldChoices: unknown, oldChoicePage = -1;
    function render(): void {
        const state = tools.getSnapshot(), preview = state.preview;
        if (state.status === "expired") {
            const hadFocus = popup.contains(document.activeElement);
            hide();
            if (hadFocus) editor.focus();
            return;
        }
        const { choicePage, choicePaging, editPaging, edits: page } = readPages();
        if (state.status === "ready") commandAction = !!preview?.command;
        status.textContent = state.status === "ready" ? state.choices.length ? preview?.command ? state.message : "Choose a small fix to apply it. Broader changes stay here for review before Apply." : "No quick fix at this position."
                : state.message;
        if (oldChoices !== state.choices || oldChoicePage !== choicePage) {
            oldChoices = state.choices; oldChoicePage = choicePage; choices.replaceChildren(...state.choices.slice(choicePage * actionChoicePageSize, (choicePage + 1) * actionChoicePageSize).map(choice => {
                const button = document.createElement("button"); button.textContent = choice.title; button.disabled = choice.disabled !== null; button.title = choice.disabled ?? ""; button.dataset.choice = String(choice.index);
                button.addEventListener("click", () => void pick(choice)); return button;
            }));
        }
        choicePages.hidden = state.choices.length <= actionChoicePageSize;
        const [back, forward] = pageActions("fixes", choicePaging);
        previousChoices = renderPanelButton(previousChoices, back); nextChoices = renderPanelButton(nextChoices, forward);
        choiceCount.textContent = `${choicePage * actionChoicePageSize + 1}–${Math.min((choicePage + 1) * actionChoicePageSize, state.choices.length)} of ${state.choices.length}`;
        for (const button of choices.querySelectorAll<HTMLButtonElement>("[data-choice]")) button.dataset.chosen = String(Number(button.dataset.choice) === state.choice);
        edits.start = (page?.page ?? 0) * editPageSize + 1;
        edits.replaceChildren(...(page?.notes ?? []).map(at => {
            const item = document.createElement("li"), before = document.createElement("del"), after = document.createElement("ins");
            before.textContent = at.before; after.textContent = at.insert + (at.insertUnits > at.insert.length ? "…" : "");
            item.append(`${at.title} `, before, " → ", after); return item;
        }));
        apply = renderPanelButton(apply, { label: preview?.command ? "Run action" : "Apply fix", reviewKey: reviewKey(preview),
            disabled: !canApply(preview), invoke: preview?.apply ?? null });
        pages.hidden = !editPaging;
        renderPanelActions(pages, pageActions("edits", editPaging));
        if (state.status === "applied" && !commandAction) queueMicrotask(() => { if (!disposed && tools.getSnapshot() === state) { dismiss(); editor.focus(); } });
    }
    scope.defer(tools.subscribe(render));
    scope.defer(provider.subscribe(() => { if (tools.getSnapshot().preview?.command) render(); }));
    // Commands can edit their own target while reporting the result to the user.
    scope.defer(editor.view.subscribe(() => { if (commandAction) anchor(); }));
    scope.defer(workspace.onDocumentChange(file.resource.documentId, change => {
        if (open && change.origin === "human") hide();
    }));
    popup.addEventListener("pointerdown", event => { if (event.target === apply) event.preventDefault(); }, { signal: events.signal });
    choices.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    close.addEventListener("click", () => { dismiss(); editor.focus(); }, { signal: events.signal });
    const bind = bindPopupCommands(scope, editor, popup, 35);
    bind("quickfix.dismiss", "Dismiss quick fixes", "Escape", () => { dismiss(); editor.focus(); });
    bind("quickfix.apply", "Apply selected fix", "Enter", () => {
        const state = tools.getSnapshot();
        if (state.preview && canApply(state.preview)) { void state.preview.apply(); return true; }
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
            editor.focus();
            void next.select({ review: true });
            return true;
        }
        return false;
    };
    bind("quickfix.previous", "Previous quick fix", "ArrowUp", () => move(-1));
    bind("quickfix.next", "Next quick fix", "ArrowDown", () => move(1));
    return Object.freeze({ request, dismiss, isOpen: () => !popup.hidden });
}
