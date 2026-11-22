import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, TextEditor } from "../../src/browser/index.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

const shortcuts = {
    complete: ["Show completions", "Ctrl+Code:Space", "Meta+Code:Space"],
    signature: ["Show signature help", "Ctrl+Shift+Space", "Meta+Shift+Space"],
    rename: ["Rename symbol", "F2"],
    inspect: ["Inspect type", "Ctrl+k Ctrl+i", "Meta+k Meta+i"],
    definition: ["Go to definition", "F12"],
    references: ["Find references", "Shift+F12"],
    quickfix: ["Show quick fixes", "Ctrl+.", "Meta+."],
} as const;
type Command = keyof typeof shortcuts;

/** Popup buttons keep native Enter activation. Escape and arrows can also run from the popup. */
export function bindPopupCommands(scope: CleanupScope, editor: TextEditor, popup: HTMLElement, priority: number) {
    const events = new AbortController(); scope.defer(() => events.abort());
    popup.addEventListener("keydown", event => editor.keymap.handle(event), { signal: events.signal });
    const enabled = () => !popup.hidden && (editor.input.matches(":focus") || popup.matches(":focus-within"));
    return (id: string, label: string, key: string, run: () => boolean | void) => {
        scope.defer(editor.commands.register({ id, label, enabled, run }, { keys: [key], priority, shared: key !== "Enter" }).dispose);
    };
}

/** Keep one explicit request at its original caret while the project starts TypeScript. */
export function mountLanguageCommands(scope: CleanupScope, editor: TextEditor, output: HTMLElement,
    execute: (command: Command, menu: boolean) => void) {
    type Intent = { command: Command; menu: boolean; capture: CapturedViewRequest<TextEditor["tab"]>; stage: "waiting" | "request" | "message" };
    let intent: Intent | undefined, phase: "starting" | "ready" | "failed" = "starting";
    const show = (message: string) => { output.textContent = message; output.hidden = !message; };
    const clear = () => {
        const previous = intent; intent = undefined; show("");
        // A provider can report a result inside a workspace notification.
        if (previous) queueMicrotask(previous.capture.cancel);
    };
    scope.defer(clear);
    const run = (command: Command, menu = true) => {
        clear();
        if (menu) editor.focus();
        if (phase === "failed") return;
        if (phase === "ready" && command !== "complete" && command !== "signature") { execute(command, menu); return; }
        const capture = captureViewRequest(editor.workspace, editor.tab, editor.view, { available: () => {
            const state = editor.activity();
            return editor.input.matches(":focus") && !state.pendingInput && !state.pendingCommand && !state.composing && !state.disposed;
        } });
        if (!capture) return;
        const next: Intent = intent = { command, menu, capture, stage: phase === "starting" ? "waiting" : "request" };
        capture.signal.addEventListener("abort", () => { if (intent === next) { intent = undefined; show(""); } }, { once: true });
        if (next.stage === "waiting") show(shortcuts[command][0] + " when TypeScript is ready…");
        else execute(command, menu);
    };
    for (const command of Object.keys(shortcuts) as Command[]) {
        const [label, ...keys] = shortcuts[command];
        scope.defer(editor.commands.register({ id: "demo.language." + command, label,
            enabled: () => phase === "starting" || phase === "ready" && command !== "rename" && command !== "inspect",
            run: () => run(command, false) }, { keys, priority: 50 }).dispose);
    }
    scope.defer(editor.commands.register({ id: "demo.language.dismiss", label: "Dismiss language request",
        enabled: () => !!intent, run: () => { const waiting = intent?.stage === "waiting"; clear(); return waiting; } },
        { keys: ["Escape"], priority: 50 }).dispose);
    const events = new AbortController(); scope.defer(() => events.abort());
    for (const name of ["blur", "beforeinput", "compositionstart"] as const)
        editor.input.addEventListener(name, () => { if (intent) clear(); }, { signal: events.signal });
    editor.element.ownerDocument.defaultView!.addEventListener("blur", () => { if (intent) clear(); }, { signal: events.signal });
    return {
        run,
        ready() {
            phase = "ready";
            const next = intent;
            if (next?.stage !== "waiting" || !next.capture.isCurrent()) return;
            next.stage = "request"; show("");
            if (next.command !== "complete" && next.command !== "signature") clear();
            execute(next.command, next.menu);
        },
        failed() { phase = "failed"; clear(); },
        feedback(command: "complete" | "signature", message: string, finished: boolean) {
            if (intent?.command !== command || intent.stage !== "request" || !intent.capture.isCurrent()) return;
            if (finished && !message) { clear(); return; }
            if (finished) intent.stage = "message";
            show(message);
        },
    };
}
