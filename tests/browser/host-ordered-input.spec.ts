import {test,expect} from "./fixtures.ts";
import type {Page} from "@playwright/test";

const snapshot=(page:Page)=>page.evaluate(()=>window.hostFixture.snapshot());
async function ready(page:Page,timeout=5000):Promise<void>{await expect.poll(()=>page.evaluate(()=>{const s=window.hostFixture.snapshot(),c=s.bindings.comparison;return s.bindings.views.every(v=>!v.metrics!.pendingCaret&&!v.metrics!.pendingWord&&!v.metrics!.pendingGrapheme&&!v.metrics!.pendingInput&&!v.metrics!.viewport.pending)&&(!c||c.status==="ready"&&!c.input.pendingCaret&&!c.input.pendingWord&&!c.input.pendingGrapheme&&!c.input.pendingInput&&!c.workingViewport.pending&&!c.referenceViewport?.pending);}),{timeout}).toBe(true);}
async function exact(page:Page,text:string):Promise<void>{expect(await page.evaluate(text=>{const f=window.hostFixture,length=f.snapshot().source.length;if(length!==text.length)return {length,expectedLength:text.length,start:f.range(0,Math.min(length,80))};for(let from=0;from<text.length;from+=32768)if(f.range(from,Math.min(text.length,from+32768))!==text.slice(from,from+32768))return {from};return null;},text)).toBeNull();}
const insert=(text:string,heads:readonly number[],data:string):string=>{const parts:string[]=[];let from=0;for(const head of heads){parts.push(text.slice(from,head),data);from=head;}parts.push(text.slice(from));return parts.join("");};

for(const host of ["plain","react"])for(const kind of ["many-carets","long-word"])test(`${host} ${kind} preserves typing behind captured navigation and shared history`,async({page})=>{
    test.setTimeout(180000);
    const original=kind==="many-carets"?Array<string>(100000).fill("0123456789").join("\r\n"):"a"+" ".repeat(1000000)+"next";
    const heads=kind==="many-carets"?Array.from({length:1024},(_,i)=>i*80*12+4):[0],destinations=kind==="many-carets"?heads.map(head=>head+12):[1000001];
    for(const mode of ["cancelled","native","input-only","paste-primary","paste-comparison"] as const){
        const paste=mode.startsWith("paste"),view=mode==="native"||mode==="paste-comparison"?"comparison" as const:"primary" as const;
        const data=paste?"xy😀é\r\n":"xy😀é",expected=insert(original,destinations,data);
        // Bulk1024-range navigation/input has a correctness deadline, not a point-latency pass.
        const inputReady=kind==="many-carets"?30000:5000;
        await page.goto(`/hosts/${host}/?editor=candidate`);await page.evaluate(text=>{const f=window.hostFixture;f.editSource(f.snapshot().source.revision,[{from:0,to:f.snapshot().source.length,insert:text}]);},original);
        for(const name of ["Open source review","Capture review acceptance","Finish review acceptance"])await page.getByRole("button",{name,exact:true}).click();await ready(page);
        const input=page.getByRole("textbox",{name:view==="primary"?"Primary source":"Comparison working source",exact:true});await input.focus();await page.evaluate(({view,heads})=>{const f=window.hostFixture;f.selectSourceSet(view,f.snapshot().source.revision,heads.map(head=>({anchor:head,head})),heads.length-1);},{view,heads});await ready(page);const before=await snapshot(page);
        const captured=await input.evaluate((node,{kind,data,mode})=>{const input=node as HTMLTextAreaElement,f=window.hostFixture;input.dispatchEvent(new KeyboardEvent("keydown",{key:kind==="many-carets"?"ArrowDown":"ArrowRight",ctrlKey:kind==="long-word",bubbles:true,cancelable:true}));
            let prevented=false;for(const fragment of [data.slice(0,2),data.slice(2)]){
                if(mode.startsWith("paste")){const event=new ClipboardEvent("paste",{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});event.clipboardData!.setData("text/plain",fragment);input.dispatchEvent(event);prevented=event.defaultPrevented;continue;}
                const event=new InputEvent("beforeinput",{inputType:"insertText",data:fragment,bubbles:true,cancelable:mode==="cancelled"});
                if(mode==="input-only"||input.dispatchEvent(event)){input.setRangeText(fragment,input.selectionStart,input.selectionEnd,"end");input.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:fragment,bubbles:true}));}prevented=event.defaultPrevented;
            }
            const s=f.snapshot(),v=input.getAttribute("aria-label")==="Primary source"?s.bindings.views.find(v=>v.id==="primary")!.metrics!:s.bindings.comparison!.input;return{prevented,pending:v.pendingInput,revision:s.source.revision};
        },{kind,data,mode});
        expect(captured.pending).toBe(true);expect(captured.revision).toBe(before.source.revision);expect(captured.prevented).toBe(mode==="cancelled"||paste);
        await ready(page,inputReady);await exact(page,expected);const after=await snapshot(page);expect(after.source.revision).toBe(before.source.revision+(paste?2:1));expect(after.history.undoDepth).toBe(before.history.undoDepth+(paste?2:1));expect(after.source.exports).toBe(0);expect(after.inputRecovery).toHaveLength(0);expect(after.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        if(paste){await page.getByRole("textbox",{name:"Secondary source",exact:true}).press("Control+z");await ready(page,inputReady);await exact(page,insert(original,destinations,data.slice(0,2)));}
        await page.getByRole("textbox",{name:"Secondary source",exact:true}).press("Control+z");await ready(page,inputReady);await exact(page,original);
        const undone=await snapshot(page),set=view==="primary"?undone.bindings.views.find(v=>v.id===view)!.selectionSet:undone.bindings.comparison!.selectionSet!;expect(set.ranges.map(r=>r.head)).toEqual(destinations);
        await input.press("Control+Shift+z");await ready(page,inputReady);if(paste){await exact(page,insert(original,destinations,data.slice(0,2)));await input.press("Control+Shift+z");await ready(page,inputReady);}await exact(page,expected);
        await page.evaluate(()=>window.hostFixture.dispose());const end=await snapshot(page);expect(end.diagnostics).toMatchObject({views:0,leases:0,subscriptions:0});expect(end.hostSubscriptions).toBe(0);
    }
});

for(const host of ["plain","react"])test(`${host} interrupted pending typing retains exact bytes without retargeting`,async({page})=>{
    test.setTimeout(180000);const original="a"+" ".repeat(1000000)+"next",text="lost😀é\r\n";
    for(const interruption of ["escape","selection","revision","permission","remount","composition","overflow","veto","late-native","paste-selection","paste-overflow","paste-veto"]){
        await page.goto(`/hosts/${host}/?editor=candidate`);await page.evaluate(original=>{const f=window.hostFixture;f.editSource(f.snapshot().source.revision,[{from:0,to:f.snapshot().source.length,insert:original}]);f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:0,head:0}]);},original);await ready(page);
        const input=page.getByRole("textbox",{name:"Primary source",exact:true});await input.focus();
        const immediate=await input.evaluate((node,{interruption,text})=>{const input=node as HTMLTextAreaElement,f=window.hostFixture,paste=interruption.startsWith("paste-");interruption=paste?interruption.slice(6):interruption;const payload=interruption==="overflow"?"r".repeat(65537):text;
            input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",ctrlKey:true,bubbles:true,cancelable:true}));
            if(paste&&interruption==="veto")input.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertText",data:"accepted",bubbles:true,cancelable:true}));
            if(interruption==="veto")input.addEventListener(paste?"paste":"beforeinput",event=>event.preventDefault(),{capture:true,once:true});
            const event=paste?new ClipboardEvent("paste",{clipboardData:new DataTransfer(),bubbles:true,cancelable:true}):new InputEvent("beforeinput",{inputType:"insertText",data:payload,bubbles:true,cancelable:interruption!=="late-native"});
            if(event instanceof ClipboardEvent)event.clipboardData!.setData("text/plain",payload);input.dispatchEvent(event);
            if(interruption==="late-native"){input.setRangeText(payload,input.selectionStart,input.selectionEnd,"end");f.setSourceReadOnly(true);f.setSourceReadOnly(false);input.dispatchEvent(new InputEvent("input",{inputType:"insertText",data:payload,bubbles:true}));}
            if(interruption==="escape"||interruption==="veto")input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
            if(interruption==="selection"){f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:1,head:1}]);f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:0,head:0}]);}
            if(interruption==="revision")f.editSource(f.snapshot().source.revision,[{from:0,to:0,insert:"new"}]);
            if(interruption==="permission"){f.setSourceReadOnly(true);f.setSourceReadOnly(false);}
            if(interruption==="remount"){f.unmount();f.mount();}
            if(interruption==="composition"){input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));input.dispatchEvent(new CompositionEvent("compositionend",{data:"",bubbles:true}));}
            return{prevented:event.defaultPrevented,text:f.recoveryText()};
        },{interruption,text});
        expect(immediate.prevented).toBe(interruption!=="late-native");await ready(page);await exact(page,(interruption==="revision"?"new":"")+original);
        const s=await snapshot(page);expect(s.source.exports).toBe(0);expect(s.inputRecovery).toHaveLength(interruption==="veto"?0:1);expect(immediate.text).toBe(interruption==="veto"?null:interruption==="paste-veto"?"accepted":interruption.endsWith("overflow")?"r".repeat(65537):text);
        await page.evaluate(()=>window.hostFixture.dispose());expect((await snapshot(page)).diagnostics).toMatchObject({views:0,leases:0,subscriptions:0});
    }
});

for(const host of ["plain","react"])test(`${host} queued editing, brackets, history and bulk indentation keep command order`,async({page})=>{
    test.setTimeout(120000);await page.goto(`/hosts/${host}/?editor=candidate`);const original="a"+" ".repeat(1000000)+"next";
    await page.evaluate(original=>{const f=window.hostFixture;f.editSource(f.snapshot().source.revision,[{from:0,to:f.snapshot().source.length,insert:original}]);f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:0,head:0}]);},original);await ready(page);
    const input=page.getByRole("textbox",{name:"Primary source",exact:true});await input.focus();
    await input.evaluate(node=>{const input=node as HTMLTextAreaElement,key=(key:string,ctrlKey=false)=>input.dispatchEvent(new KeyboardEvent("keydown",{key,ctrlKey,bubbles:true,cancelable:true})),type=(data:string)=>{
        if(input.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertText",data,bubbles:true,cancelable:true}))){input.setRangeText(data,input.selectionStart,input.selectionEnd,"end");input.dispatchEvent(new InputEvent("input",{inputType:"insertText",data,bubbles:true}));}};
        key("ArrowRight",true);type("ab");key("Backspace");key("(");key(")");key("Tab");type("z");key("z",true);type("Q");
    });await ready(page);await exact(page,original.slice(0,1000001)+"a()    Qnext");expect((await snapshot(page)).inputRecovery).toHaveLength(0);
    // Span more than one command turn by work count, without relying on a slow machine.
    const lines=Array<string>(4096).fill("row").join("\r\n");await page.evaluate(lines=>{const f=window.hostFixture;f.editSource(f.snapshot().source.revision,[{from:0,to:f.snapshot().source.length,insert:lines}]);f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:0,head:lines.length}]);},lines);await ready(page);
    const before=await snapshot(page);expect(await input.evaluate(node=>{const input=node as HTMLTextAreaElement;input.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));return !input.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertText",data:"done",bubbles:true,cancelable:true}));})).toBe(true);await ready(page);
    await exact(page,"    done");expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth+2);await input.press("Control+z");await ready(page);await exact(page,lines.split("\r\n").map(line=>"    "+line).join("\r\n"));await input.press("Control+z");await ready(page);await exact(page,lines);
    await page.evaluate(()=>window.hostFixture.dispose());expect((await snapshot(page)).diagnostics).toMatchObject({views:0,leases:0,subscriptions:0});
});

for(const host of ["plain","react"])test(`${host} Save and Run require settled typing and retain captured revisions`,async({page})=>{
    test.setTimeout(120000);await page.goto(`/hosts/${host}/?editor=candidate`);const original="a"+" ".repeat(1000000)+"next",expected=original.slice(0,1000001)+"typednext";
    await page.evaluate(original=>{const f=window.hostFixture;f.editSource(f.snapshot().source.revision,[{from:0,to:f.snapshot().source.length,insert:original}]);f.selectSourceSet("primary",f.snapshot().source.revision,[{anchor:0,head:0}]);},original);await ready(page);
    const input=page.getByRole("textbox",{name:"Primary source",exact:true});await input.focus();
    const blocked=await input.evaluate(node=>{const input=node as HTMLTextAreaElement;input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",ctrlKey:true,bubbles:true,cancelable:true}));input.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertText",data:"typed",bubbles:true,cancelable:true}));for(const name of ["Save source","Run captured inputs"])([...document.querySelectorAll("button")].find(button=>button.textContent===name) as HTMLButtonElement).click();const s=window.hostFixture.snapshot();return{saves:s.pendingSaves.length,runs:s.pendingRuns.length,modal:s.layout.modal};});
    expect(blocked.saves).toBe(0);expect(blocked.runs).toBe(0);expect(JSON.stringify(blocked.modal)).toContain("pending typing");await ready(page);await exact(page,expected);expect((await snapshot(page)).source.exports).toBe(0);
    await page.getByRole("button",{name:"Dismiss message",exact:true}).click();const settled=await snapshot(page);await page.getByRole("button",{name:"Save source",exact:true}).click();await expect.poll(async()=>(await snapshot(page)).pendingSaves.length).toBe(1);expect((await snapshot(page)).pendingSaves[0]).toMatchObject({revision:settled.source.revision,length:expected.length});
    await page.getByRole("button",{name:"Run captured inputs",exact:true}).click();await expect.poll(async()=>(await snapshot(page)).pendingRuns.length).toBe(1);expect((await page.evaluate(()=>window.hostFixture.runCapture(0)))!.source).toBe(expected);
    await page.evaluate(()=>{const f=window.hostFixture,s=f.snapshot();f.selectSourceSet("primary",s.source.revision,[{anchor:s.source.length,head:s.source.length}]);});await input.pressSequentially("Q");await ready(page);await page.evaluate(()=>{window.hostFixture.finishSave();window.hostFixture.finishRun();});await expect.poll(async()=>(await snapshot(page)).source.saveStatus).toBe("idle");expect((await snapshot(page)).source.dirty).toBe(true);await exact(page,expected+"Q");await input.press("Control+z");await ready(page);await exact(page,expected);expect((await snapshot(page)).source.dirty).toBe(false);
    await page.evaluate(()=>window.hostFixture.dispose());const end=await snapshot(page);expect(end.diagnostics).toMatchObject({views:0,leases:0,subscriptions:0});expect(end.inputCaptureGuards).toBe(0);expect(end.hostSubscriptions).toBe(0);
});
