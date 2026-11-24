import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test("viewport maps retained source rows through newline edits without stale content or coordinates", async ({ page }, testInfo) => {
    const built = await build({ entryPoints: { core: "src/index.ts", viewport: "src/browser/viewport.ts", rows: "src/core/comparison-rows.ts" },
        outdir: "artifacts/row-retention", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/row-retention/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/row-retention/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const { ComparisonRowsCursor } = await import(path + "rows.js") as typeof import("../../src/core/comparison-rows.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "retained-rows", variant: "text" }, "Rows",
            { value: Array.from({ length: 1200 }, (_, i) => `const row_${i} = ${i};`).join("\r\n") });
        const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "rows"), host = document.createElement("section");
        host.style.cssText = "height:260px;width:800px;position:fixed;top:0;left:0"; document.body.append(host);
        let shade = "row-token", early = false;
        const stopEarly = workspace.observeDocument(source.documentId).subscribe(() => { if (early) viewport.flush(); });
        const { viewport, setComparisonRows } = mountViewport(host, workspace, tab);
        viewport.decorations.addProvider({ name: "syntax", order: 0,
            provide: row => [{ from: row.from, to: Math.min(row.to, row.from + 5), className: shade }], lineClass: row => row.line % 2 ? "row-odd" : "row-even" });
        const doc = () => workspace.document(source.documentId), row = (line: number) => host.querySelector<HTMLElement>(`.st-viewport-row[data-line="${line}"]`)!;
        const mounted = () => [...host.querySelectorAll<HTMLElement>(".st-viewport-row")];
        const settle = () => { for (let i = 0; i < 8; i++) { viewport.flush(); if (!viewport.activity().pending) return; } throw new Error("Viewport did not settle"); };
        const edit = (edits: readonly import("../../src/core/changes.ts").TextEdit[]) => {
            const result = workspace.edit({ documentId: source.documentId, expectedRevision: doc().revision, origin: "human", edits });
            if (!result.applied) throw new Error("Fixture edit rejected");
        };
        const history = (direction: "undo" | "redo") => { if (!workspace[direction]({ documentId: source.documentId, expectedRevision: doc().revision }).applied) throw new Error("History rejected"); };
        const exact = () => mounted().every(node => {
            const from = Number(node.dataset.from), to = Number(node.dataset.to), line = Number(node.dataset.line);
            return node.textContent === doc().buffer.slice(from, to).replaceAll("\r", "␍") && doc().buffer.lineAt(from) === line
                && node.classList.contains(line % 2 ? "row-odd" : "row-even");
        });
        const nativeError = (line: number, column = 14) => {
            const offset = doc().buffer.offsetAt(line) + column, node = row(line), point = viewport.coordsAt(offset)!;
            let local = offset - Number(node.dataset.from); const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                if (local >= text.textContent!.length) { local -= text.textContent!.length; continue; }
                const range = document.createRange(); range.setStart(text, local); range.setEnd(text, local + 1);
                const native = range.getBoundingClientRect(); return Math.max(Math.abs(point.left - native.left), Math.abs(point.top - native.top));
            }
            throw new Error("Missing native geometry oracle");
        };
        let target = 502;
        const work: { name: string; eligible: number; nodes: number; children: number; target: boolean; exact: boolean; error: number }[] = [];
        const run = (name: string, change: () => void) => {
            const tracked = row(target), before = new Map(mounted().map(node => [node.textContent!, { node, children: [...node.childNodes] }]));
            change(); settle(); let eligible = 0, nodes = 0, children = 0;
            for (const node of mounted()) {
                const old = before.get(node.textContent!); if (!old) continue; eligible++;
                if (node === old.node) nodes++;
                if (old.children.length === node.childNodes.length && old.children.every((child, i) => node.childNodes[i] === child)) children++;
            }
            work.push({ name, eligible, nodes, children, target: row(target) === tracked, exact: exact(), error: nativeError(target) });
        };
        try {
            viewport.revealOffset(doc().buffer.offsetAt(target)); settle();
            const from = doc().buffer.offsetAt(target); viewport.view.setSelection(doc().revision, { anchor: from + 6, head: from + 11 }); settle();
            run("insert one line", () => { const from = doc().buffer.offsetAt(target - 1); edit([{ from, to: from, insert: "inserted\r\n" }]); target++; });
            run("delete the line", () => { edit([{ from: doc().buffer.offsetAt(target - 2), to: doc().buffer.offsetAt(target - 1), insert: "" }]); target--; });
            run("queued revisions", () => {
                for (let i = 0; i < 3; i++) { const from = doc().buffer.offsetAt(target - 1); edit([{ from, to: from, insert: `queued ${i}\r\n` }]); target++; }
            });
            run("batch with zero net line delta", () => {
                const before = doc().buffer.offsetAt(target - 1), after = doc().buffer.offsetAt(target + 3);
                edit([{ from: before, to: before, insert: "\r\n" }, { from: after - 2, to: after, insert: "" }]); target++;
            });
            run("undo", () => { history("undo"); target--; });
            run("redo", () => { history("redo"); target++; });
            run("host flush before document notification", () => {
                early = true;
                try { const from = doc().buffer.offsetAt(target - 1); edit([{ from, to: from, insert: "early\r\n" }]); target++; }
                finally { early = false; }
            });
            run("changed neighboring contents", () => { const from = doc().buffer.offsetAt(target - 1); edit([{ from, to: from + 5, insert: "other" }]); });
            viewport.view.folding.setRanges(viewport.view.folding.getSnapshot(), [{ id: "fold", from: doc().buffer.offsetAt(target - 5), to: doc().buffer.offsetAt(target - 2), collapsed: true }]); settle();
            run("mapped folds", () => { edit([{ from: 0, to: 0, insert: "header\r\n" }]); target++; });
            const folds = viewport.view.folding.getSnapshot(), buffer = doc().buffer, cursor = new ComparisonRowsCursor(buffer, buffer, Object.freeze([]), folds.index, folds.index);
            let alignment = cursor.next(4096); while (!alignment.result) alignment = cursor.next(4096); cursor.dispose();
            setComparisonRows({ documentId: source.documentId, revision: doc().revision, foldGeneration: folds.generation, id: 1,
                lineHeight: viewport.getSnapshot().lineHeight + 2, index: alignment.result.working }); settle();
            run("expired alignment", () => { edit([{ from: 0, to: 0, insert: "aligned header\n" }]); target++; });
            const selected = row(target).querySelector(".st-viewport-selected")?.textContent;
            const token = row(target).querySelector(".row-token");
            shade = "row-token-new"; viewport.invalidate(); settle();
            const refreshed = row(target).querySelector(".row-token-new") !== null && token !== row(target).firstChild;
            // Identical clipped text is not an identity: preserve the actual mapped source row.
            edit([{ from: 0, to: doc().buffer.length, insert: Array.from({ length: 80 }, (_, i) => `row_${i} ` + "x".repeat(5000)).join("\n") }]);
            target = 40; viewport.revealOffset(doc().buffer.offsetAt(target) + 2000); settle();
            const clipped = row(target), clippedChild = clipped.firstChild, neighbor = row(target - 1);
            edit([{ from: doc().buffer.offsetAt(target - 2), to: doc().buffer.offsetAt(target - 2), insert: "\n" }]); target++; settle();
            const fragment = { partial: viewport.getDiagnostics().partialRows > 0, retained: row(target) === clipped && row(target).firstChild === clippedChild,
                neighbor: row(target - 1) === neighbor, exact: exact(), error: nativeError(target, 2000) };
            // Deleting an empty CRLF row must not steal the next empty row or identical neighbors.
            edit([{ from: 0, to: doc().buffer.length, insert: "\r\n\nsame\nsame\n" }]); viewport.scrollTo({ top: 0, left: 0 }); settle();
            const empty = row(1), sameA = row(2), sameB = row(3), eof = row(4);
            edit([{ from: 0, to: 2, insert: "" }]); settle();
            const deletion = row(0) === empty && row(1) === sameA && row(2) === sameB && row(3) === eof;
            edit([{ from: 0, to: 0, insert: "\n" }]); settle();
            const insertion = row(0) !== empty && row(1) === empty && row(2) === sameA && row(3) === sameB && row(4) === eof;
            edit([{ from: doc().buffer.length - 1, to: doc().buffer.length, insert: "" }]); settle();
            const joinedEnd = row(3) === sameB && !eof.isConnected;
            return { work, selected, refreshed, fragment, deletion, insertion, joinedEnd, exact: exact(), exports: doc().buffer.readMetrics().textExports };
        } finally { stopEarly(); viewport.dispose(); workspace.tabs.close(tab); workspace.releaseResource(source.id, true); host.remove(); }
    });
    await testInfo.attach("row-retention", { body: JSON.stringify(result), contentType: "application/json" });
    for (const work of result.work) {
        expect(work.target, work.name).toBe(true); expect(work.eligible, work.name).toBeGreaterThan(3);
        expect(work.nodes, work.name).toBe(work.eligible); expect(work.children, work.name).toBe(work.eligible);
        expect(work.exact, work.name).toBe(true); expect(work.error, work.name).toBeLessThan(1.1);
    }
    expect(result).toMatchObject({ selected: "row_5", refreshed: true, deletion: true, insertion: true, joinedEnd: true, exact: true, exports: 0 });
    expect(result.fragment).toMatchObject({ partial: true, retained: true, neighbor: true, exact: true }); expect(result.fragment.error).toBeLessThan(1.1);
});
