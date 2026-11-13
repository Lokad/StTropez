import type { HostActionsTools, ActionNote, ActionChoice } from "./code-actions.ts";
export function actionsControls(tools: HostActionsTools) {
    const s = tools.state.getSnapshot();
    return [
        { label: "Preview module action", invoke: tools.request, disabled: !s.available || s.disconnected || s.pending },
        { label: s.command ? "Execute captured action" : "Apply captured action", invoke: () => tools.apply(s.token), disabled: !s.canApply },
        { label: "Dismiss action preview", invoke: tools.cancel, disabled: s.token === null },
        ...(tools.usesLsp ? [{ label: "Previous action choices", invoke: () => tools.moveChoicePage(-1), disabled: s.pending || s.choicePage === 0 },
            { label: "Next action choices", invoke: () => tools.moveChoicePage(1), disabled: s.pending || (s.choicePage + 1) * 16 >= s.choices.length },
            { label: "Previous action edits", invoke: () => tools.previousPage(), disabled: s.pending || s.page === 0 },
            { label: "Next action edits", invoke: () => tools.nextPage(), disabled: s.pending || (s.page + 1) * 64 >= s.editCount }] : []),
        { label: "Disconnect action provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect action provider", invoke: tools.reconnect, disabled: !s.disconnected && !s.reconnectRequired && s.status !== "failed" }
    ];
}
export const actionsDescription = "Preview an import of the chosen module into the captured working source. Existing exact import lines disable the action. This local fixture uses its own bounded import policy; it does not resolve symbols, modules or types.";
export const actionsDescriptionFor = (tools: HostActionsTools): string => tools.usesLsp ? "Choose a provider action and review its captured edits or advertised command, then confirm. Commands run after their edits; any further provider edits require a decision in Workspace provider. Some choices load a preview when selected. This sample uses lexical/import policies, not general type or scope resolution." : actionsDescription;
export const actionChoiceLabel = (choice: ActionChoice): string => `${choice.title}${choice.kind ? ` · ${choice.kind}` : ""}${choice.preferred ? " · preferred" : ""}${choice.disabled ? ` · ${choice.disabled}` : choice.needsResolve ? " · Load preview" : ""}`;
export const actionTarget = (at: ActionNote): string => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}${at.insertUnits !== undefined && at.insertUnits > at.insert.length ? `… (${at.insertUnits} UTF-16 units)` : ""}\nContext: ${at.context}`;
export function mountActionsPanel(host: HTMLElement, tools: HostActionsTools): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), label = owner.createElement("label"), module = owner.createElement("input"), controls = owner.createElement("div"), title = owner.createElement("p"), edits = owner.createElement("ol"), changed = owner.createElement("button");
    const choices = owner.createElement("ol"), changes = owner.createElement("div"); choices.setAttribute("aria-label", "Provider code actions"); changes.setAttribute("aria-label", "Action changed resources");
    heading.textContent = "Code actions"; description.textContent = actionsDescriptionFor(tools); status.setAttribute("aria-label", "Code action status");
    module.type = "text"; module.maxLength = 64; module.value = tools.state.getSnapshot().module; module.oninput = () => tools.setModule(module.value); label.append("Action module ", module); tools.bindModule(module);
    title.setAttribute("aria-label", "Captured action title"); edits.setAttribute("aria-label", "Proposed action edits"); changed.onclick = tools.openChanged;
    const buttons = actionsControls(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(heading, description, status, label, controls, ...(tools.usesLsp ? [choices] : []), title, edits, ...(tools.usesLsp ? [changes] : [changed])); let previous: unknown, previousChoices: unknown, previousChanges: unknown;
    let choiceButtons: HTMLButtonElement[] = [], previousChoicePage = -1;
    const render = () => { const s = tools.state.getSnapshot(); status.textContent = s.message; if (module.value !== s.module) module.value = s.module; title.textContent = s.title;
        for (const [i, action] of actionsControls(tools).entries()) { buttons[i]!.textContent = action.label; buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        if (previousChoices !== s.choices || previousChoicePage !== s.choicePage) { previousChoices = s.choices; previousChoicePage = s.choicePage; choiceButtons = []; choices.start = s.choicePage * 16 + 1; choices.replaceChildren(...s.choices.slice(s.choicePage * 16, (s.choicePage + 1) * 16).map(choice => { const li = owner.createElement("li"), button = owner.createElement("button"); button.textContent = actionChoiceLabel(choice); button.onclick = () => { if (tools.state.getSnapshot().token === s.token) tools.selectChoice(choice.index); }; choiceButtons.push(button); li.append(button); return li; })); }
        for (const [index, button] of choiceButtons.entries()) { button.disabled = s.pending; button.setAttribute("aria-pressed", String(s.choice === s.choicePage * 16 + index)); }
        if (previous !== s.edits) { previous = s.edits; edits.start = s.page * 64 + 1; edits.replaceChildren(...s.edits.map(at => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = actionTarget(at); li.append(pre); return li; })); }
        if (previousChanges !== s.changes) { previousChanges = s.changes; changes.replaceChildren(...s.changes.map(change => { const button = owner.createElement("button"); button.textContent = `Open action changes in ${change.title}`; button.onclick = () => tools.openChangedDocument(change.document); return button; })); }
        for (const button of changes.querySelectorAll("button")) button.disabled = s.token !== null;
        changed.hidden = !s.changed; changed.disabled = s.token !== null; changed.textContent = s.changed ? `Open action changes in ${s.changed.title}` : "Open action changes";
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); tools.bindModule(null); host.replaceChildren(); };
}
