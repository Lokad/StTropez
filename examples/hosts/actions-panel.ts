import { pageActions } from "./panel-actions.ts";
import { bindChoiceList, createPanelTextField, createDestinationList, createToolPanel } from "./tool-panel.ts";
import { changedFiles, createEditNoteList } from "./edit-review.ts";
import { actionChoicePageSize } from "./action-pages.ts";
import type { CodeActionChoice } from "../../src/browser/index.ts";
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

/** Choices and confirmations belong to the displayed preview. */
export function actionsPanelModel(tools: ActionsPanelTools, s: ActionsSnapshot) {
    return {
        title: "Code actions", description: actionsDescription, status: { label: "Code action status", text: s.message },
        module: { label: "Action module ", value: s.module, maxLength: 64, bind: tools.bindModule, change: (value: string) => tools.setModule(value) },
        actions: actionsControls(tools, s),
        choices: { label: "Provider code actions", identity: s.choices, page: s.choicePage, start: s.choicePage * actionChoicePageSize + 1,
            disabled: s.pending && !s.resolving, isSelected: (index: number) => s.choice === index,
            items: () => s.choices.slice(s.choicePage * actionChoicePageSize, (s.choicePage + 1) * actionChoicePageSize).map(choice => ({ key: choice.index, label: actionChoiceLabel(choice),
                invoke: () => choice.select({ review: true }) } as const)) },
        preview: { label: "Captured action title", text: s.title },
        edits: { label: "Proposed action edits", page: s.page, notes: s.edits },
        changes: changedFiles("Action changed resources", "Open action changes in ", s.changes, s.active, id => tools.openChangedDocument(id)),
    } as const;
}
export function mountActionsPanel(host: HTMLElement, tools: HostActionsTools): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => actionsPanelModel(tools, state));
    const module = createPanelTextField(owner, initial.module), title = owner.createElement("p"), edits = createEditNoteList(owner, initial.edits.label);
    const choices = owner.createElement("ol"), changes = createDestinationList(owner, initial.changes);
    const renderChoices = bindChoiceList(choices, initial.choices);
    title.setAttribute("aria-label", initial.preview.label);
    return mount([module.label, controls, choices, title, edits.element, changes.element], model => {
        module.render(model.module.value); title.textContent = model.preview.text;
        choices.start = model.choices.start;
        renderChoices(model.choices);
        edits.render(model.edits);
        changes.render(model.changes);
    }, module.dispose);
}
