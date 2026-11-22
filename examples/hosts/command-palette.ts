import { captureViewRequest, type TextEditor } from "../../src/browser/index.ts";
import { isUnmodifiedShortcut } from "../shared/host-shortcuts.ts";
import { shortcutHint } from "../shared/shortcut-hint.ts";

export function registerCommandPalette(editor: TextEditor): () => void {
    let dismiss: (() => void) | undefined;
    function open() {
        const capture = captureViewRequest(editor.workspace, editor.tab, editor.view);
        if (!capture) return false;
        const doc = editor.element.ownerDocument, dialog = doc.createElement("dialog"), filter = doc.createElement("input");
        const list = doc.createElement("select"), run = doc.createElement("button"), cancel = doc.createElement("button");
        const label = doc.createElement("label"), controls = doc.createElement("div"), events = new AbortController();
        dialog.className = "host-command-palette"; dialog.setAttribute("aria-label", "Editor commands");
        label.textContent = "Filter commands"; filter.type = "search"; label.append(filter);
        list.size = 8; list.setAttribute("aria-label", "Matching commands");
        run.textContent = "Run command"; cancel.textContent = "Cancel"; controls.append(run, cancel);
        dialog.append(label, list, controls);
        editor.focus();
        const choices = editor.commands.list().filter(command => command.id !== "host.commands")
            .map(command => ({ ...command, shortcut: shortcutHint(editor.keymap.getShortcuts(command.id)) }))
            .sort((a, b) => a.label.localeCompare(b.label));

        function render() {
            const query = filter.value.trim().toLowerCase();
            list.replaceChildren();
            for (const command of choices) {
                if (!command.label.toLowerCase().includes(query) && !command.id.toLowerCase().includes(query)) continue;
                const option = doc.createElement("option");
                option.value = command.id; option.disabled = !command.enabled;
                option.textContent = command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
                list.append(option);
            }
            if (!list.options.length) {
                const empty = doc.createElement("option");
                empty.textContent = "No matching commands"; empty.disabled = true; list.append(empty);
            }
            const first = Array.from(list.options).find(option => !option.disabled);
            list.selectedIndex = first?.index ?? -1;
            run.disabled = !first;
        }
        const close = () => {
            if (events.signal.aborted) return;
            events.abort(); dismiss = undefined; dialog.close(); dialog.remove(); capture.cancel();
        };
        const cancelAndFocus = () => { close(); editor.focus(); };
        const execute = () => {
            const id = list.value;
            if (!id || run.disabled) return;
            capture.commit(() => {
                close(); editor.focus();
                return editor.commands.run(id);
            });
        };
        dismiss = close;
        const listeners = { signal: events.signal };
        capture.signal.addEventListener("abort", close, listeners);
        editor.signal.addEventListener("abort", close, listeners);
        filter.addEventListener("input", render, listeners);
        dialog.addEventListener("cancel", event => { event.preventDefault(); cancelAndFocus(); }, listeners);
        dialog.addEventListener("close", close, listeners);
        dialog.addEventListener("keydown", event => {
            if (!isUnmodifiedShortcut(event)) return;
            if (event.key === "Escape") { event.preventDefault(); cancelAndFocus(); return; }
            if (event.key === "ArrowDown" && event.target === filter && !run.disabled) { event.preventDefault(); list.focus(); }
            if (event.key === "Enter" && (event.target === filter || event.target === list)) { event.preventDefault(); execute(); }
        }, listeners);
        run.addEventListener("click", execute, listeners);
        cancel.addEventListener("click", cancelAndFocus, listeners);
        try { render(); doc.body.append(dialog); dialog.showModal(); filter.focus(); }
        catch (error) { close(); throw error; }
        return true;
    }
    const command = editor.commands.register({ id: "host.commands", label: "Editor commands", enabled: () => !dismiss, run: open },
        { keys: ["Mod+k Mod+p"], repeat: false });
    return () => { dismiss?.(); command.dispose(); };
}
