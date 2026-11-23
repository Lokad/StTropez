import type { TextEditor } from "../../src/browser/index.ts";
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
    const enabled = () => !popup.hidden && (editor.getSnapshot().focused || popup.matches(":focus-within"));
    return (id: string, label: string, key: string, run: () => boolean | void) => {
        scope.defer(editor.commands.register({ id, label, enabled, run }, { keys: [key], priority, shared: key !== "Enter" }).dispose);
    };
}

/** Keep one explicit request at its original caret while the project starts TypeScript. */
export function mountLanguageCommands(scope: CleanupScope, editor: TextEditor, output: HTMLElement,
    execute: (command: Command, menu: boolean) => void, reportError: (error: unknown) => void) {
    type Feedback = (command: "complete" | "signature", message: string, finished: boolean) => void;
    const lane = editor.latestOperation(); scope.defer(lane.dispose);
    let phase: "starting" | "ready" | "failed" = "starting";
    let resume: (() => void) | undefined, receive: Feedback | undefined;
    const show = (message: string) => { output.textContent = message; output.hidden = !message; };
    const run = (command: Command, menu = true) => {
        lane.cancel();
        if (menu) editor.focus();
        if (phase === "failed" || !editor.getSnapshot().focused) return;
        if (phase === "ready" && command !== "complete" && command !== "signature") { execute(command, menu); return; }
        void lane.run({}, async op => {
            op.signal.addEventListener("abort", () => { resume = undefined; receive = undefined; show(""); }, { once: true });
            const dispatch = () => {
                resume = undefined; show("");
                if (command !== "complete" && command !== "signature") { execute(command, menu); return; }
                // Keep an empty-result message at its originating caret until the user leaves it.
                return new Promise<void>(done => {
                    op.signal.addEventListener("abort", () => done(), { once: true });
                    receive = (feature, message, finished) => {
                        if (feature !== command) return;
                        show(message);
                        if (finished) { receive = undefined; if (!message) done(); }
                    };
                    execute(command, menu);
                });
            };
            if (phase === "starting") {
                show(shortcuts[command][0] + " when TypeScript is ready…");
                await op.step(new Promise<void>(ready => { resume = ready; }), dispatch);
            } else await dispatch();
        }).catch(reportError);
    };
    for (const command of Object.keys(shortcuts) as Command[]) {
        const [label, ...keys] = shortcuts[command];
        scope.defer(editor.commands.register({ id: "demo.language." + command, label,
            enabled: from => phase === "starting" || phase === "ready" && (from === "menu" || command !== "rename" && command !== "inspect"),
            run: from => run(command, from === "menu") }, { keys, priority: 50 }).dispose);
    }
    scope.defer(editor.commands.register({ id: "demo.language.dismiss", label: "Dismiss language request",
        enabled: () => !!resume || !!receive || !output.hidden, run: () => { const waiting = !!resume; lane.cancel(); return waiting; } },
        { keys: ["Escape"], priority: 50 }).dispose);
    const events = new AbortController(); scope.defer(() => events.abort());
    scope.defer(editor.subscribe(() => { if (!editor.getSnapshot().focused) lane.cancel(); }));
    editor.onEditIntent(lane.cancel, events.signal);
    editor.element.ownerDocument.defaultView!.addEventListener("blur", lane.cancel, { signal: events.signal });
    return {
        ready() { phase = "ready"; resume?.(); },
        failed() { phase = "failed"; lane.cancel(); },
        notice(message: string, signal: AbortSignal) {
            void lane.run({ signal }, op => new Promise<void>(done => {
                show(message);
                op.signal.addEventListener("abort", () => { show(""); done(); }, { once: true });
            })).catch(reportError);
        },
        feedback: (...args: Parameters<Feedback>) => receive?.(...args),
    };
}
