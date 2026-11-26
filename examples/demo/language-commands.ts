import { captureViewRequest, type CapturedViewRequest, type TextEditor } from "../../src/browser/index.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

const shortcuts = {
    complete: ["Show completions", "Mod+Code:Space"],
    signature: ["Show signature help", "Mod+Shift+Space"],
    rename: ["Rename symbol", "F2"],
    inspect: ["Inspect type", "Mod+k Mod+i"],
    definition: ["Go to definition", "F12"],
    references: ["Find references", "Shift+F12"],
    quickfix: ["Show quick fixes", "Mod+."],
} as const;
type Command = keyof typeof shortcuts;

/** Keep one explicit request at its original caret while the project starts TypeScript. */
export function mountLanguageCommands(scope: CleanupScope, editor: TextEditor, output: HTMLElement,
    execute: (command: Command) => void, reportError: (error: unknown) => void) {
    type Feedback = (command: "complete" | "signature", message: string, finished: boolean) => void;
    let pending: CapturedViewRequest | undefined;
    let phase: "starting" | "ready" | "failed" = "starting";
    let resume: (() => void) | undefined, receive: Feedback | undefined;
    const show = (message: string) => { output.textContent = message; output.hidden = !message; };
    function cancel() {
        const source = pending;
        if (!source) return;
        pending = undefined;
        resume = undefined;
        receive = undefined;
        show("");
        // Feedback can finish inside a controller notification. Release the lease after delivery.
        queueMicrotask(source.cancel);
    }
    scope.defer(cancel);
    function capture(signal?: AbortSignal) {
        if (signal?.aborted || editor.signal.aborted) return;
        const source = captureViewRequest(editor, { available: () => {
            const input = editor.activity();
            return editor.element.isConnected && !editor.getSnapshot().disabled && !input.disposed
                && input.input === "idle";
        } });
        if (!source) return;
        pending = source;
        const expire = () => { if (pending === source) cancel(); };
        source.signal.addEventListener("abort", expire, { once: true });
        signal?.addEventListener("abort", expire, { once: true, signal: source.signal });
        return source;
    }
    const run = (command: Command, menu = true) => {
        cancel();
        if (menu) editor.focus();
        if (phase === "failed" || !editor.getSnapshot().focused) return;
        if (phase === "ready" && command !== "complete" && command !== "signature") { execute(command); return; }
        const source = capture();
        if (!source) return;
        const dispatch = () => {
            if (pending !== source || !source.isCurrent()) return;
            resume = undefined;
            show("");
            if (command === "complete" || command === "signature") {
                receive = (feature, message, finished) => {
                    if (feature !== command || pending !== source || !source.isCurrent()) return;
                    show(message);
                    if (finished) {
                        receive = undefined;
                        if (!message) cancel();
                    }
                };
            } else cancel();
            try { execute(command); }
            catch (error) { if (pending === source) cancel(); reportError(error); }
        };
        if (phase === "starting") {
            show(shortcuts[command][0] + " when TypeScript is ready…");
            resume = dispatch;
        } else dispatch();
    };
    for (const command of Object.keys(shortcuts) as Command[]) {
        const [label, ...keys] = shortcuts[command];
        scope.defer(editor.commands.register({ id: "demo.language." + command, label,
            enabled: from => phase === "starting" || phase === "ready" && (from === "menu" || command !== "rename" && command !== "inspect" && command !== "quickfix"),
            run: from => run(command, from === "menu") }, { keys, priority: 50 }).dispose);
    }
    scope.defer(editor.commands.register({ id: "demo.language.dismiss", label: "Dismiss language request",
        enabled: () => !!resume || !!receive || !output.hidden, run: () => { const waiting = !!resume; cancel(); return waiting; } },
        { keys: ["Escape"], priority: 50 }).dispose);
    const events = new AbortController(); scope.defer(() => events.abort());
    scope.defer(editor.subscribe(() => { if (!editor.getSnapshot().focused) cancel(); }));
    editor.onEditIntent(cancel, events.signal);
    editor.element.ownerDocument.defaultView!.addEventListener("blur", cancel, { signal: events.signal });
    return {
        ready() { phase = "ready"; if (resume) queueMicrotask(resume); },
        failed() { phase = "failed"; cancel(); },
        notice(message: string, signal: AbortSignal) {
            cancel();
            if (capture(signal)) show(message);
        },
        feedback: (...args: Parameters<Feedback>) => receive?.(...args),
    };
}
