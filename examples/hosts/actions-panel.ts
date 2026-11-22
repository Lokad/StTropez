import { pageActions } from "./panel-actions.ts";
import { createToolPanel } from "./tool-panel.ts";
import { actionChoicePageSize, actionEditPageSize } from "./action-pages.ts";
import type { CodeActionChoice } from "../../src/browser/index.ts";
import type { LspWorkspaceEditNote } from "../../src/protocol/index.ts";
import type { HostActionsTools, ActionsSnapshot } from "./code-actions.ts";
type ActionsPanelTools = Pick<HostActionsTools, "request" | "cancel" | "disconnect" | "reconnect" | "bindModule" | "setModule" | "openChangedDocument">;
function actionsControls(tools: ActionsPanelTools, s: ActionsSnapshot) {
    return [
        { label: "Preview module action", invoke: tools.request, disabled: !s.available || s.disconnected || s.pending },
        { label: s.command ? "Execute captured action" : "Apply captured action", reviewKey: s.reviewKey, invoke: () => s.confirm?.(), disabled: !s.canApply },
        { label: "Dismiss action preview", invoke: tools.cancel, disabled: !s.active },
        ...pageActions("action choices", s.choicePaging),
        ...pageActions("action edits", s.editPaging),
        { label: "Disconnect action provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect action provider", invoke: tools.reconnect, disabled: !s.disconnected && !s.reconnectRequired && s.status !== "failed" }
    ];
}
export const actionsDescription = "Choose a provider action and review its captured edits or advertised command, then confirm. Commands run after their edits; any further provider edits require a decision in Workspace provider. Some choices load a preview when selected. This sample uses lexical/import policies, not general type or scope resolution.";
export const actionChoiceLabel = (choice: CodeActionChoice): string => `${choice.title}${choice.kind ? ` · ${choice.kind}` : ""}${choice.preferred ? " · preferred" : ""}${choice.disabled ? ` · ${choice.disabled}` : choice.needsResolve ? " · Load preview" : ""}`;
export const actionTarget = (at: LspWorkspaceEditNote): string => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}${at.insertUnits > at.insert.length ? `… (${at.insertUnits} UTF-16 units)` : ""}\nContext: ${at.context}`;

/** Choices and confirmations belong to the displayed preview. */
export function actionsPanelModel(tools: ActionsPanelTools, s: ActionsSnapshot) {
    return {
        title: "Code actions", description: actionsDescription, status: { label: "Code action status", text: s.message },
        module: { label: "Action module ", value: s.module, maxLength: 64, bind: tools.bindModule, change: (value: string) => tools.setModule(value) },
        actions: actionsControls(tools, s),
        choices: { label: "Provider code actions", identity: s.choices, page: s.choicePage, start: s.choicePage * actionChoicePageSize + 1,
            disabled: s.pending, isSelected: (index: number) => s.choice === index,
            items: () => s.choices.slice(s.choicePage * actionChoicePageSize, (s.choicePage + 1) * actionChoicePageSize).map(choice => ({ key: choice.index, label: actionChoiceLabel(choice),
                invoke: () => choice.select() } as const)) },
        preview: { label: "Captured action title", text: s.title },
        edits: { label: "Proposed action edits", identity: s.edits, start: s.page * actionEditPageSize + 1, items: () => s.edits.map(actionTarget) },
        changes: { label: "Action changed resources", identity: s.changes, disabled: s.active,
            items: () => s.changes.map(change => ({ key: change.document,
                label: `Open action changes in ${change.title}`, invoke: () => tools.openChangedDocument(change.document) } as const)) },
    } as const;
}
export function mountActionsPanel(host: HTMLElement, tools: HostActionsTools): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => actionsPanelModel(tools, state));
    const label = owner.createElement("label"), module = owner.createElement("input"), title = owner.createElement("p"), edits = owner.createElement("ol");
    const choices = owner.createElement("ol"), changes = owner.createElement("div"); choices.setAttribute("aria-label", initial.choices.label); changes.setAttribute("aria-label", initial.changes.label);
    module.type = "text"; module.maxLength = initial.module.maxLength; module.value = initial.module.value; module.oninput = () => initial.module.change(module.value); label.append(initial.module.label, module); initial.module.bind(module);
    title.setAttribute("aria-label", initial.preview.label); edits.setAttribute("aria-label", initial.edits.label);
    let previous: unknown, previousChoices: unknown, previousChanges: unknown;
    let choiceButtons: { key: number; button: HTMLButtonElement }[] = [], previousChoicePage: number | undefined;
    return mount([label, controls, choices, title, edits, changes], model => {
        if (module.value !== model.module.value) module.value = model.module.value; title.textContent = model.preview.text;
        if (previousChoices !== model.choices.identity || previousChoicePage !== model.choices.page) { previousChoices = model.choices.identity; previousChoicePage = model.choices.page; choiceButtons = []; choices.start = model.choices.start; choices.replaceChildren(...model.choices.items().map(choice => { const li = owner.createElement("li"), button = owner.createElement("button"); button.textContent = choice.label; button.onclick = choice.invoke; choiceButtons.push({ key: choice.key, button }); li.append(button); return li; })); }
        for (const { key, button } of choiceButtons) { button.disabled = model.choices.disabled; button.setAttribute("aria-pressed", String(model.choices.isSelected(key))); }
        if (previous !== model.edits.identity) { previous = model.edits.identity; edits.start = model.edits.start; edits.replaceChildren(...model.edits.items().map(text => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = text; li.append(pre); return li; })); }
        if (previousChanges !== model.changes.identity) { previousChanges = model.changes.identity; changes.replaceChildren(...model.changes.items().map(change => { const button = owner.createElement("button"); button.textContent = change.label; button.onclick = change.invoke; return button; })); }
        for (const button of changes.querySelectorAll("button")) button.disabled = model.changes.disabled;
    }, () => initial.module.bind(null));
}
