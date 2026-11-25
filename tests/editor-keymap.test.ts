import assert from "node:assert/strict";
import test from "node:test";
import { createCommandRegistry } from "../src/browser/command-registry.ts";
import { defaultEditorShortcuts, editorCommandLabels } from "../src/browser/editor-commands.ts";

type Key = readonly [key: string, code: string, keyCode: number];
const named: Record<string, number> = {
    Tab: 9, Enter: 13, Backspace: 8, Delete: 46, Home: 36, End: 35,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34,
};
const punctuation: Record<string, readonly [us: Key, french: Key]> = {
    "/": [["/", "Slash", 191], [":", "Period", 191]],
    ".": [[".", "Period", 190], [";", "Comma", 59]],
    "[": [["[", "BracketLeft", 219], [")", "Minus", 219]],
    "]": [["]", "BracketRight", 221], ["Dead", "BracketLeft", 0]],
    "{": [["{", "BracketLeft", 219], ["°", "Minus", 219]],
    "}": [["}", "BracketRight", 221], ["Dead", "BracketLeft", 221]],
    "|": [["|", "Backslash", 220], ["µ", "Backslash", 220]],
};
const bindings = {
    "Tab": "indent", "Shift+Tab": "outdent", Enter: "newline", "Shift+Enter": "newline",
    "Ctrl+z": "undo", "Ctrl+Shift+z": "redo", "Ctrl+y": "redo", "Ctrl+a": "select-all",
    "Ctrl+u": "undo-caret", "Ctrl+Shift+k": "delete-lines", "Ctrl+Enter": "insert-line-below",
    "Ctrl+Shift+Enter": "insert-line-above", "Ctrl+]": "indent-lines", "Ctrl+[": "outdent",
    "Alt+ArrowUp": "move-line-up", "Alt+ArrowDown": "move-line-down",
    "Alt+Shift+ArrowUp": "copy-line-up", "Alt+Shift+ArrowDown": "copy-line-down",
    "Ctrl+Alt+ArrowUp": "add-caret-above", "Ctrl+Alt+ArrowDown": "add-caret-below",
    "Ctrl+l": "select-line", "Ctrl+d": "select-next-occurrence", "Ctrl+g": "go-to-line",
    "Ctrl+Shift+l": "select-all-occurrences", "Ctrl+Shift+|": "jump-to-bracket",
    "Alt+PageUp": "scroll-page-up", "Alt+PageDown": "scroll-page-down",
    "Ctrl+/": "line-comment", "Alt+Shift+a": "block-comment", "Ctrl+ArrowUp": "scroll-line-up",
    "Ctrl+ArrowDown": "scroll-line-down", Backspace: "delete-backward", "Shift+Backspace": "delete-backward",
    Delete: "delete-forward", "Ctrl+Backspace": "delete-word-backward", "Ctrl+Delete": "delete-word-forward",
    "Ctrl+Shift+Backspace": "delete-word-backward", "Ctrl+Shift+Delete": "delete-word-forward",
};

for (const layout of ["US International", "French AZERTY"]) {
    test(`default editing shortcuts on ${layout}`, t => {
        const registry = createCommandRegistry(false, () => true, () => () => true);
        t.after(() => registry.dispose());
        const dispatched: string[] = [];
        for (const [id, label] of Object.entries(editorCommandLabels)) {
            registry.commands.register({ id, label, run: () => { dispatched.push(id); } });
        }
        for (const [keys, id] of defaultEditorShortcuts.standard) registry.keymap.bind(keys, id);
        const hostBindings = [
            ["quick-fix", "Ctrl+."], ["fold", "Ctrl+Shift+["], ["unfold", "Ctrl+Shift+]"], ["host", "Ctrl+Alt+]"],
        ] as const;
        for (const [id, shortcut] of hostBindings) {
            registry.commands.register({ id, label: id, run: () => { dispatched.push(id); } }, { keys: [shortcut] });
        }
        function send([key, code, keyCode]: Key, modifiers: string[], altGraph = false) {
            const event = Object.assign(new Event("keydown", { cancelable: true }), {
                key, code, keyCode, ctrlKey: modifiers.includes("Ctrl"), altKey: modifiers.includes("Alt"),
                shiftKey: modifiers.includes("Shift"), metaKey: false,
                getModifierState: (name: string) => name === "AltGraph" && altGraph,
            }) as unknown as KeyboardEvent;
            const count = dispatched.length;
            const handled = registry.handleEditor(event, registry.commands.run);
            assert.equal(event.defaultPrevented, handled);
            return dispatched[count] ?? null;
        }
        function check(shortcut: string, command: string | null) {
            const modifiers = shortcut.split("+");
            const name = modifiers.pop()!;
            const french = layout === "French AZERTY";
            let stroke: Key;
            if (punctuation[name]) stroke = punctuation[name][french ? 1 : 0];
            else if (named[name]) stroke = [name, name, named[name]];
            else {
                assert.match(name, /^[a-z]$/);
                const letter = name.toUpperCase();
                const physical = french ? ({ A: "Q", Z: "W" }[letter] ?? letter) : letter;
                stroke = [modifiers.includes("Shift") ? letter : name, "Key" + physical, letter.charCodeAt(0)];
            }
            assert.equal(send(stroke, modifiers), command, shortcut);
        }
        for (const [keys, id] of Object.entries(bindings)) check(keys, id);
        for (const [key, direction] of Object.entries({
            ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
            PageUp: "page-up", PageDown: "page-down",
        })) {
            check(key, "move-" + direction);
            check("Shift+" + key, "select-" + direction);
        }
        for (const [key, direction] of [["Home", "start"], ["End", "end"]] as const) {
            check(key, "move-to-line-" + direction);
            check("Shift+" + key, "select-to-line-" + direction);
            check("Ctrl+" + key, "move-to-document-" + direction);
            check("Ctrl+Shift+" + key, "select-to-document-" + direction);
        }
        for (const [key, direction] of [["ArrowLeft", "backward"], ["ArrowRight", "forward"]] as const) {
            check("Ctrl+" + key, "move-word-" + direction);
            check("Ctrl+Shift+" + key, "select-word-" + direction);
        }
        check("Ctrl+.", "quick-fix");
        check("Ctrl+Shift+{", "fold");
        check("Ctrl+Shift+}", "unfold");
        check("Shift+Delete", null);
        assert.equal(send(["Dead", layout === "French AZERTY" ? "BracketLeft" : "Quote", 0], []), null);
        const altStroke: Key = ["]", layout === "French AZERTY" ? "Minus" : "BracketRight", 221];
        assert.equal(send(altStroke, ["Ctrl", "Alt"]), "host");
        assert.equal(send(altStroke, ["Ctrl", "Alt"], true), null);
        assert.equal(send(["z", "KeyZ", 229], ["Ctrl"]), null);
        if (layout === "French AZERTY") {
            assert.equal(send([".", "Comma", 190], ["Ctrl", "Shift"]), null);
            assert.equal(send(["/", "Period", 191], ["Ctrl", "Shift"]), null);
            assert.equal(send(["$", "BracketRight", 186], ["Ctrl"]), null);
        }
        // The editing browser test dispatches both strokes and checks which lines they change.
        for (const [id, suffix] of [["add-line-comment", "c"], ["remove-line-comment", "u"]] as const) {
            assert.ok(registry.keymap.getShortcuts(id).includes("Mod+k Mod+" + suffix));
        }
    });
}
