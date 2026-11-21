import { commandBudget } from "./cooperative-runner.ts";
import type { createCooperativeRunner } from "./cooperative-runner.ts";
import type { KeyBinding, KeyStroke } from "./editing-keys.ts";

export type InputKey = KeyStroke & KeyBinding & { kind: "key" };
export type InputIntent = (InputKey | { kind: "text"; text: string; type: string; literal?: true; wholeLines?: boolean }) & { at?: number };
type Command<C> = Readonly<{ capture: C; purpose: "word" | "grapheme" }>;
export type OrderedInput<C> = { capture: C; purpose: Command<C>["purpose"]; actions: InputIntent[]; units: number;
    edit: boolean; native: boolean; running?: InputIntent; cancelled?: boolean };

/** Retains ordered intent and recovery ownership. The editor validates captures and executes each action. */
export function createOrderedInputQueue<C extends Readonly<{ deleting: boolean }>>(
    clock: Pick<Performance, "now">, runner: Pick<ReturnType<typeof createCooperativeRunner>, "schedule">,
    owner: Readonly<{
        command: () => Command<C> | undefined; capture: () => C; disposed: () => boolean;
        validCommand: (capture: C) => boolean; valid: (capture: C, editing: boolean) => boolean; committed: (capture: C) => boolean;
        pairKey: (text: string) => boolean; replay: (action: InputIntent) => boolean | "reported";
        recover: (pending: OrderedInput<C>, text: string, reason: string) => void;
        commandTurn: (work: () => void) => void; deferredTurn: (work: () => void) => void;
    }>) {
    let ordered: OrderedInput<C> | undefined, executing: OrderedInput<C> | undefined, cancelTask: (() => void) | undefined;
    let draining = false, replayTime: number | undefined;
    function take(): OrderedInput<C> | undefined {
        cancelTask?.(); cancelTask = undefined;
        const pending = ordered; ordered = undefined; return pending;
    }
    function recover(pending: OrderedInput<C>, reason: string): void {
        if (pending.cancelled) return; pending.cancelled = true;
        const text = (owner.committed(pending.capture) ? "" : pending.running?.text ?? "") + pending.actions.map(action => action.text).join("");
        delete pending.running; pending.actions = []; pending.units = 0;
        // Release all retained text before invoking host recovery, which may reenter the editor.
        owner.recover(pending, text, reason);
    }
    const current = (pending: OrderedInput<C>) => !pending.cancelled && owner.valid(pending.capture, pending.edit);
    function ensure(): OrderedInput<C> | undefined {
        if (ordered) return ordered;
        const command = owner.command(); if (!command || !owner.validCommand(command.capture)) return;
        return ordered = { capture: command.capture, purpose: command.purpose, actions: [], units: 0, edit: command.capture.deleting, native: false };
    }
    function append(action: InputIntent): OrderedInput<C> | undefined {
        const pending = ensure(); if (!pending) return;
        action.at = clock.now();
        if (!current(pending) || pending.actions.length >= commandBudget.queuedActions || pending.units + action.text.length > commandBudget.queuedUnits) {
            return pending;
        }
        const last = pending.actions.at(-1);
        if (last?.kind === "text" && action.kind === "text" && last.type === "insertText" && action.type === "insertText" && last.literal === action.literal
            && !owner.pairKey(last.text) && !owner.pairKey(action.text) && action.at - (last.at ?? action.at) < 1000) { last.text += action.text; last.at = action.at; }
        else pending.actions.push(action);
        pending.units += action.text.length; pending.edit ||= action.kind === "text" || action.edit;
        schedule();
    }
    function schedule(): void {
        if (!ordered || owner.command() || ordered.native || cancelTask !== undefined) return;
        const cancel = runner.schedule(() => { if (cancelTask === cancel) cancelTask = undefined; drain(); }, 0, owner.deferredTurn);
        cancelTask = cancel;
    }
    function drain(): void {
        const pending = take(); if (!pending) return;
        if (!current(pending)) { recover(pending, "pending-input-expired"); return; }
        const began = clock.now(); let count = 0; draining = true; executing = pending;
        try { owner.commandTurn(() => {
            while (pending.actions.length && count++ < commandBudget.queuedCalls && clock.now() - began < commandBudget.sliceMs) {
                const action = pending.actions.shift()!; pending.running = action; replayTime = action.at;
                const result = owner.replay(action);
                if (result !== true) {
                    if (result === "reported") delete pending.running;
                    recover(pending, "pending-input-rejected"); return;
                }
                replayTime = undefined; delete pending.running; pending.units -= action.text.length;
                if (pending.cancelled || owner.disposed()) return;
                const command = owner.command();
                if (command) {
                    if (pending.actions.length || pending.native || command.capture.deleting) { pending.capture = command.capture; pending.purpose = command.purpose; ordered = pending; }
                    return;
                }
                pending.capture = owner.capture();
                if (!current(pending)) { recover(pending, "pending-input-expired"); return; }
            }
            if (pending.actions.length || pending.native) { ordered = pending; schedule(); }
        }); }
        finally { replayTime = undefined; if (executing === pending) executing = undefined; draining = false; }
    }
    function complete(capture: C, work: () => boolean): boolean {
        const pending = ordered?.capture === capture ? take() : undefined;
        if (pending) executing = pending;
        let applied = false;
        try { applied = work(); return applied; }
        finally {
            if (pending && !pending.cancelled) {
                if (applied && !owner.disposed()) { pending.capture = owner.capture(); ordered = pending; schedule(); }
                else recover(pending, "pending-input-expired");
            }
            if (executing === pending) executing = undefined;
        }
    }
    return Object.freeze({
        get pending() { return ordered; }, get executing() { return executing; }, get draining() { return draining; }, get time() { return replayTime; },
        take, recover, current, ensure, append, schedule, complete,
        /** Consume recovery ownership immediately after commit, before presentation can fail. */
        consumeRunning(): void { if (executing) delete executing.running; },
        waitNative(pending: OrderedInput<C>): void { pending.native = true; pending.edit = true; },
        finishNative(pending: OrderedInput<C>): void { pending.native = false; },
    });
}
