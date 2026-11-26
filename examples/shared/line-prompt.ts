import type { LinePrompt } from "../../src/browser/index.ts";
import { isPrimaryShortcut } from "./host-shortcuts.ts";
import "./line-prompt.css";

export function linePrompt(owner: Document): LinePrompt {
    return ({ currentLine, lineCount, signal }) =>
        new Promise((resolve) => {
            const dialog = owner.createElement("dialog"),
                form = owner.createElement("form");
            const label = owner.createElement("label"),
                input = owner.createElement("input");
            const go = owner.createElement("button"),
                cancel = owner.createElement("button");
            dialog.className = "host-line-prompt";
            dialog.setAttribute("aria-label", "Go to line");
            dialog.setAttribute("closedby", "any");
            label.textContent = `Line (1–${lineCount})`;
            input.inputMode = "numeric";
            input.required = true;
            input.value = String(currentLine);
            label.append(input);
            go.textContent = "Go";
            cancel.textContent = "Cancel";
            cancel.type = "button";
            form.append(label, go, cancel);
            dialog.append(form);
            const finish = (line?: number) => {
                signal.removeEventListener("abort", dismiss);
                dialog.close();
                dialog.remove();
                resolve(line);
            };
            const dismiss = () => finish();
            input.addEventListener("input", () => input.setCustomValidity(""));
            form.addEventListener("submit", (event) => {
                event.preventDefault();
                const value = input.value.trim();
                const line = Number(value);
                if (!/^\d+$/.test(value) || line < 1 || line > lineCount) {
                    input.setCustomValidity(`Enter a whole line number from 1 to ${lineCount}.`);
                    input.reportValidity();
                    return;
                }
                finish(line);
            });
            cancel.addEventListener("click", dismiss);
            dialog.addEventListener("cancel", (event) => {
                event.preventDefault();
                dismiss();
            });
            dialog.addEventListener("keydown", (event) => {
                if (!isPrimaryShortcut(event) || event.shiftKey || event.key.toLowerCase() !== "g") return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) {
                    input.focus();
                    input.select();
                }
            });
            if (signal.aborted) {
                resolve(undefined);
                return;
            }
            signal.addEventListener("abort", dismiss, { once: true });
            owner.body.append(dialog);
            dialog.showModal();
            input.select();
        });
}
