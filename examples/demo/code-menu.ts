import type { TextEditor } from "../../src/browser/index.ts";
import { shortcutHint } from "../shared/shortcut-hint.ts";

export function mountCodeMenuCommands(menu: HTMLDetailsElement, pane: () => TextEditor | undefined,
    source: () => TextEditor | undefined, signal: AbortSignal) {
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button[data-command]"));
    for (const button of buttons) button.addEventListener("click", () => {
        const editor = pane(), id = button.dataset.command!;
        if (!editor?.commands.get(id, "menu")?.enabled) return;
        editor.focus();
        editor.commands.run(id, "menu");
    }, { signal });
    function renderButtons() {
        const editor = pane();
        for (const button of buttons) {
            const id = button.dataset.command!, command = editor?.commands.get(id, "menu");
            const label = command?.label ?? source()?.commands.get(id, "menu")?.label ?? "";
            if (label !== button.textContent) button.textContent = label;
            const hint = command && editor ? shortcutHint(editor.keymap.getShortcuts(id)) : "";
            if (button.title !== hint) button.title = hint;
            button.disabled = !command?.enabled;
        }
    }
    const refresh = () => { if (menu.open) renderButtons(); };
    menu.querySelector("summary")!.addEventListener("click", () => { if (!menu.open) renderButtons(); }, { signal });
    menu.addEventListener("toggle", refresh, { signal });
    return refresh;
}
