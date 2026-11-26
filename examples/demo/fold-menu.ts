import type { FoldCommand, FoldingController, TextEditor } from "../../src/browser/index.ts";
import { showMenuShortcut } from "./code-menu.ts";

/** A pane offers folding commands when it has a folding controller. */
export function mountDemoFoldMenu(menu: HTMLDetailsElement, activePane: () => TextEditor | undefined) {
    const group = menu.querySelector<HTMLSelectElement>("#fold-group")!,
        status = menu.querySelector<HTMLOutputElement>("#folding-status")!;
    const commands = [
        ["fold", "fold.collapse"],
        ["unfold", "fold.expand"],
        ["fold-group-collapse", "fold.collapse-all"],
        ["fold-group-expand", "fold.expand-all"]
    ] as const;
    const buttons = commands.map(([id, command]) => ({
        button: menu.querySelector<HTMLButtonElement>(`#${id}`)!,
        command
    }));
    type Target = { name: string; editor: TextEditor; controller: FoldingController };
    const targets = new Map<TextEditor, Target>();
    let groups: readonly string[] | undefined;
    const target = () => {
        const editor = activePane();
        return editor && targets.get(editor);
    };
    const listeners = new AbortController();
    const filter = (command: FoldCommand) => (command.endsWith("-all") && group.value ? group.value : undefined);
    function renderCommands() {
        const active = target();
        for (const { button, command } of buttons) {
            const entry = active?.editor.commands.get(command, filter(command));
            const label = entry?.label ?? targets.keys().next().value?.commands.get(command)?.label ?? "";
            if (button.textContent !== label) button.textContent = label;
            showMenuShortcut(button, active && entry ? active.editor.keymap.getShortcuts(command) : []);
            button.disabled = !entry?.enabled;
        }
    }
    function render() {
        const active = target();
        const state = active?.controller.getSnapshot();
        if (groups !== state?.groups) {
            groups = state?.groups;
            const selected = group.value;
            group.replaceChildren(
                new Option("All groups", ""),
                ...(groups ?? []).map((name) => new Option(name, name))
            );
            if (groups?.includes(selected)) group.value = selected;
        }
        group.disabled = !groups?.length;
        status.textContent =
            state && active
                ? `${active.name} · ${state.message || `${state.regions} ${state.regions === 1 ? "fold" : "folds"} · ${state.collapsed} collapsed`}`
                : "";
        if (menu.open) renderCommands();
    }
    for (const { button, command } of buttons)
        button.addEventListener(
            "click",
            () => {
                target()?.editor.commands.run(command, filter(command));
            },
            { signal: listeners.signal }
        );
    group.addEventListener("change", renderCommands, { signal: listeners.signal });
    menu.addEventListener(
        "toggle",
        () => {
            if (menu.open) renderCommands();
        },
        { signal: listeners.signal }
    );
    renderCommands();
    function bind(editor: TextEditor, controller: FoldingController, name: string) {
        targets.set(editor, { name, editor, controller });
        const stop = controller.subscribe(() => {
            if (activePane() === editor) render();
        });
        const stopRender = editor.viewport.onRender(() => {
            if (menu.open && activePane() === editor) renderCommands();
        });
        render();
        return () => {
            stop();
            stopRender();
            targets.delete(editor);
            render();
        };
    }
    return { bind, render, dispose: () => listeners.abort() };
}
