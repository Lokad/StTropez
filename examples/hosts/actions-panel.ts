import { pageActions, renderPanelActions } from "./panel-actions.ts";
import { actionChoicePageSize, actionEditPageSize } from "./action-pages.ts";
import type { HostActionsTools, ActionNote, ActionChoice, ActionsSnapshot } from "./code-actions.ts";
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
export const actionChoiceLabel = (choice: ActionChoice): string => `${choice.title}${choice.kind ? ` · ${choice.kind}` : ""}${choice.preferred ? " · preferred" : ""}${choice.disabled ? ` · ${choice.disabled}` : choice.needsResolve ? " · Load preview" : ""}`;
export const actionTarget = (at: ActionNote): string => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}${at.insertUnits !== undefined && at.insertUnits > at.insert.length ? `… (${at.insertUnits} UTF-16 units)` : ""}\nContext: ${at.context}`;

/** Choices and confirmations belong to the displayed preview. */
export function actionsPanelModel(tools: ActionsPanelTools, s: ActionsSnapshot) {
    return {
        title: "Code actions", description: actionsDescription, status: { label: "Code action status", text: s.message },
        module: { label: "Action module ", value: s.module, maxLength: 64, bind: tools.bindModule, change: (value: string) => tools.setModule(value) },
        actions: actionsControls(tools, s),
        choices: { enabled: true, label: "Provider code actions", identity: s.choices, page: s.choicePage, start: s.choicePage * actionChoicePageSize + 1,
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
    const initial = actionsPanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), label = owner.createElement("label"), module = owner.createElement("input"), controls = owner.createElement("div"), title = owner.createElement("p"), edits = owner.createElement("ol");
    const choices = owner.createElement("ol"), changes = owner.createElement("div"); choices.setAttribute("aria-label", initial.choices.label); changes.setAttribute("aria-label", initial.changes.label);
    host.setAttribute("aria-label", initial.title); heading.textContent = initial.title; description.textContent = initial.description; status.setAttribute("aria-label", initial.status.label);
    module.type = "text"; module.maxLength = initial.module.maxLength; module.value = initial.module.value; module.oninput = () => initial.module.change(module.value); label.append(initial.module.label, module); initial.module.bind(module);
    title.setAttribute("aria-label", initial.preview.label); edits.setAttribute("aria-label", initial.edits.label);
    host.replaceChildren(heading, description, status, label, controls, ...(initial.choices.enabled ? [choices] : []), title, edits, changes); let previous: unknown, previousChoices: unknown, previousChanges: unknown;
    let choiceButtons: { key: number; button: HTMLButtonElement }[] = [], previousChoicePage: number | undefined;
    const render = () => { const model = actionsPanelModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text; if (module.value !== model.module.value) module.value = model.module.value; title.textContent = model.preview.text;
        renderPanelActions(controls, model.actions);
        if (previousChoices !== model.choices.identity || previousChoicePage !== model.choices.page) { previousChoices = model.choices.identity; previousChoicePage = model.choices.page; choiceButtons = []; choices.start = model.choices.start; choices.replaceChildren(...model.choices.items().map(choice => { const li = owner.createElement("li"), button = owner.createElement("button"); button.textContent = choice.label; button.onclick = choice.invoke; choiceButtons.push({ key: choice.key, button }); li.append(button); return li; })); }
        for (const { key, button } of choiceButtons) { button.disabled = model.choices.disabled; button.setAttribute("aria-pressed", String(model.choices.isSelected(key))); }
        if (previous !== model.edits.identity) { previous = model.edits.identity; edits.start = model.edits.start; edits.replaceChildren(...model.edits.items().map(text => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = text; li.append(pre); return li; })); }
        if (previousChanges !== model.changes.identity) { previousChanges = model.changes.identity; changes.replaceChildren(...model.changes.items().map(change => { const button = owner.createElement("button"); button.textContent = change.label; button.onclick = change.invoke; return button; })); }
        for (const button of changes.querySelectorAll("button")) button.disabled = model.changes.disabled;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); initial.module.bind(null); host.replaceChildren(); };
}
