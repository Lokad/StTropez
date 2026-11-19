import type { FoldCommand, FoldingController, TextEditor } from "../../src/browser/index.ts";

/** Keep the last source pane as the command target while the menu itself holds focus. */
export function mountDemoFoldMenu(menu: HTMLDetailsElement) {
    const group = menu.querySelector<HTMLSelectElement>("#fold-group")!, status = menu.querySelector<HTMLOutputElement>("#folding-status")!;
    const commands = [["fold", "collapse"], ["unfold", "expand"], ["fold-group-collapse", "collapse-all"], ["fold-group-expand", "expand-all"]] as const;
    const buttons = commands.map(([id, command]) => ({ button: menu.querySelector<HTMLButtonElement>(`#${id}`)!, command }));
    type Target = { name: string; controller: FoldingController };
    let active: Target | undefined, primary: Target | undefined, groups: readonly string[] | undefined;
    const listeners = new AbortController();
    const filter = (command: FoldCommand) => command.endsWith("-all") && group.value ? group.value : undefined;
    function renderCommands() {
        for (const { button, command } of buttons) button.disabled = !active?.controller.canRunCommand(command, filter(command));
    }
    function render() {
        const state = active?.controller.getSnapshot();
        if (groups !== state?.groups) {
            groups = state?.groups;
            const selected = group.value;
            group.replaceChildren(new Option("All groups", ""), ...(groups ?? []).map(name => new Option(name, name)));
            if (groups?.includes(selected)) group.value = selected;
        }
        group.disabled = !groups?.length;
        status.textContent = state && active ? `${active.name} · ${state.message || `${state.regions} ${state.regions === 1 ? "fold" : "folds"} · ${state.collapsed} collapsed`}` : "";
        if (menu.open) renderCommands();
    }
    for (const { button, command } of buttons) button.addEventListener("click", () => {
        active?.controller.runCommand(command, filter(command));
    }, { signal: listeners.signal });
    group.addEventListener("change", renderCommands, { signal: listeners.signal });
    menu.addEventListener("toggle", () => { if (menu.open) renderCommands(); }, { signal: listeners.signal });
    renderCommands();
    function bind(editor: TextEditor, controller: FoldingController, name: string, isPrimary: boolean) {
        const target = { name, controller }, events = new AbortController();
        if (isPrimary) { primary = target; active = target; }
        const activate = () => { if (active !== target) { active = target; render(); } };
        editor.element.addEventListener("focusin", activate, { signal: events.signal });
        editor.element.addEventListener("pointerdown", activate, { capture: true, signal: events.signal });
        const stop = controller.subscribe(() => { if (active === target) render(); });
        const stopRender = editor.viewport.onRender(() => { if (menu.open && active === target) renderCommands(); });
        render();
        return () => {
            events.abort(); stop(); stopRender();
            if (primary === target) primary = undefined;
            if (active === target) { active = primary; render(); }
        };
    }
    return { bind, dispose: () => listeners.abort() };
}
