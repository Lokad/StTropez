import type { LinePrompt } from "../../src/browser/index.ts";
import "./line-prompt.css";

export function linePrompt(owner: Document): LinePrompt {
    return ({ currentLine, lineCount, signal }) => new Promise(resolve => {
        const dialog = owner.createElement("dialog"), form = owner.createElement("form");
        const label = owner.createElement("label"), input = owner.createElement("input");
        const go = owner.createElement("button"), cancel = owner.createElement("button");
        dialog.className = "host-line-prompt"; dialog.setAttribute("aria-label", "Go to line");
        label.textContent = `Line (1–${lineCount})`;
        input.type = "number"; input.required = true; input.min = "1"; input.max = String(lineCount);
        input.value = String(currentLine); label.append(input);
        go.textContent = "Go"; cancel.textContent = "Cancel"; cancel.type = "button";
        form.append(label, go, cancel); dialog.append(form);
        const finish = (line?: number) => {
            signal.removeEventListener("abort", dismiss);
            dialog.close(); dialog.remove(); resolve(line);
        };
        const dismiss = () => finish();
        form.addEventListener("submit", event => { event.preventDefault(); finish(input.valueAsNumber); });
        cancel.addEventListener("click", dismiss);
        dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
        if (signal.aborted) { resolve(undefined); return; }
        signal.addEventListener("abort", dismiss, { once: true });
        owner.body.append(dialog); dialog.showModal(); input.select();
    });
}
