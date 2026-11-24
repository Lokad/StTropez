import { ready,test,expect} from "./fixtures.ts";
import type {Page} from "@playwright/test";

const snapshot=(page:Page)=>page.evaluate(()=>window.hostFixture.snapshot());

async function exact(page:Page,text:string):Promise<void>{expect(await page.evaluate(text=>{const f=window.hostFixture,length=f.snapshot().source.length;if(length!==text.length)return {length,expectedLength:text.length,start:f.range(0,Math.min(length,80))};for(let from=0;from<text.length;from+=32768)if(f.range(from,Math.min(text.length,from+32768))!==text.slice(from,from+32768))return {from};return null;},text)).toBeNull();}

test("queued Apple caret chords and native history keep their captured selection and command order", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
    await page.goto("/hosts/plain/");
    const prefix = "a".repeat(200001) + ";end\r\n", original = prefix + "last";
    await page.evaluate(text => { const f = window.hostFixture;
        f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]);
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]);
    }, original); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus(); const before = await snapshot(page);
    const captured = await input.evaluate(node => {
        const key = (key: string, modifiers: KeyboardEventInit) => node.dispatchEvent(new KeyboardEvent("keydown", { key, ...modifiers, bubbles: true, cancelable: true }));
        const prevented = [!key("ArrowRight", { ctrlKey: true }), !key("ArrowDown", { metaKey: true }), !key("ArrowLeft", { metaKey: true, shiftKey: true })];
        for (const [inputType, data] of [["insertText", "R"], ["historyUndo", null], ["historyRedo", null]] as const)
            prevented.push(!node.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true })));
        const state = window.hostFixture.snapshot();
        return { prevented, revision: state.source.revision, pending: state.bindings.views.find(view => view.id === "primary")!.metrics!.pendingInput };
    });
    expect(captured.prevented.every(Boolean)).toBe(true); expect(captured.pending).toBe(true); expect(captured.revision).toBe(before.source.revision);
    await ready(page, 30000); await exact(page, prefix + "R"); const after = await snapshot(page);
    expect(after.source.revision).toBe(before.source.revision + 3); expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
    expect(after.bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: prefix.length + 1, head: prefix.length + 1 });
    expect(after.inputRecovery).toHaveLength(0); expect(after.source.exports).toBe(0);
    await input.pressSequentially("!"); await ready(page); await exact(page, prefix + "R!");
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

test(`plain Save and Run require settled typing and retain captured revisions`,async({page})=>{
    test.setTimeout(120000);await page.goto(`/hosts/plain/`);const original="a".repeat(200001)+";end",expected=original.slice(0,200001)+"typed;end";
    await page.evaluate(original=>{const f=window.hostFixture;f.editSource(f.snapshot().source.revision,[{from:0,to:f.snapshot().source.length,insert:original}]);f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:0,head:0}]);},original);await ready(page);
    const input=page.getByRole("textbox",{name:"Primary source",exact:true});await input.focus();
    const blocked=await input.evaluate(node=>{const input=node as HTMLTextAreaElement;input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",ctrlKey:true,bubbles:true,cancelable:true}));input.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertText",data:"typed",bubbles:true,cancelable:true}));for(const name of ["Save source","Run captured inputs"])([...document.querySelectorAll("button")].find(button=>button.textContent===name) as HTMLButtonElement).click();const s=window.hostFixture.snapshot();return{saves:s.pendingSaves.length,runs:s.pendingRuns.length,modal:s.layout.modal};});
    expect(blocked.saves).toBe(0);expect(blocked.runs).toBe(0);expect(JSON.stringify(blocked.modal)).toContain("pending typing");await ready(page);await exact(page,expected);expect((await snapshot(page)).source.exports).toBe(0);
    await page.getByRole("button",{name:"Dismiss message",exact:true}).click();const settled=await snapshot(page);await page.getByRole("button",{name:"Save source",exact:true}).click();await expect.poll(async()=>(await snapshot(page)).pendingSaves.length).toBe(1);expect((await snapshot(page)).pendingSaves[0]).toMatchObject({revision:settled.source.revision,length:expected.length});
    await page.getByRole("button",{name:"Run captured inputs",exact:true}).click();await expect.poll(async()=>(await snapshot(page)).pendingRuns.length).toBe(1);expect((await page.evaluate(()=>window.hostFixture.runCapture(0)))!.source).toBe(expected);
    await page.evaluate(()=>{const f=window.hostFixture,s=f.snapshot();f.selectSourceSet("primary",s.source.revision,[{anchor:s.source.length,head:s.source.length}]);});await input.pressSequentially("Q");await ready(page);await page.evaluate(()=>{window.hostFixture.finishSave();window.hostFixture.finishRun();});await expect.poll(async()=>(await snapshot(page)).source.saveStatus).toBe("idle");expect((await snapshot(page)).source.dirty).toBe(true);await exact(page,expected+"Q");await input.press("Control+z");await ready(page);await exact(page,expected);expect((await snapshot(page)).source.dirty).toBe(false);
    await page.evaluate(()=>window.hostFixture.dispose());const end=await snapshot(page);expect(end.diagnostics).toMatchObject({views:0,leases:0,subscriptions:0});expect(end.inputCaptureGuards).toBe(0);expect(end.hostSubscriptions).toBe(0);
});
