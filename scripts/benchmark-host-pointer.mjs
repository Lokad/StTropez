import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import {openHarness} from "./browser-harness.mjs";
import {sourceIdentity,environment,distribution as measuredDistribution} from "./measurement.mjs";
import {createHostScene} from "./host-scene.mjs";
import {typeHostSuffix} from "./host-typing.mjs";

const source=await sourceIdentity(),smoke=process.env.STTROPEZ_POINTER_SMOKE==="1",warmup=smoke?0:3,measured=smoke?1:10;
/** @param {readonly number[]} values */
const distribution=values=>({...measuredDistribution(values),max:Math.max(...values)}),directory="artifacts/bench/host-pointer";
const h=await openHarness(),page=h.page,scene=createHostScene(page),cases=[],displays=[];let activeCase;
const snapshot=scene.snapshot;
/** @param {string} name */
const click=name=>page.getByRole("button",{name,exact:true}).click();
const ready=scene.ready,root=()=>page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
const exact=scene.exactText,dispose=scene.dispose;
try{for(const host of ["plain","react"])for(const corpus of ["unicode-crlf","lines-100000"])for(const cancellation of ["capture-loss","synthetic-cancel"]){
    const original=Array(corpus==="unicode-crlf"?60:100000).fill("const sample = '😀 é';").join("\r\n"),samples=[];
    for(let iteration=0;iteration<warmup+measured;iteration++){
        activeCase={host,corpus,cancellation,iteration,stage:"setup"};await dispose();await scene.mount(host);
        await page.evaluate(text=>{const f=window.hostFixture,s=f.snapshot();f.editSource(s.source.revision,[{from:0,to:s.source.length,insert:text}]);},original);
        await click("Open source review");await ready();await click("Save source");await page.waitForFunction(()=>window.hostFixture.snapshot().pendingSaves.length===1);
        await page.evaluate(()=>window.hostFixture.finishSave());await page.waitForFunction(()=>window.hostFixture.snapshot().pendingCommands===0&&window.hostFixture.snapshot().source.serverVersion==="v1");
        await click("Capture reference refresh");await click("Finish reference refresh");await ready();assert.equal(await exact(original),true);
        const working=page.getByRole("textbox",{name:"Comparison working source",exact:true});await working.press("Control+Home");for(let i=0;i<10;i++)await working.press("ArrowRight");for(let i=0;i<2;i++)await working.press("Shift+ArrowRight");
        assert.equal(await page.evaluate(()=>{const f=window.hostFixture;return f.selectSource("secondary",f.snapshot().source.revision,{anchor:4,head:1});}),true);await ready();
        await root().scrollIntoViewIfNeeded();
        const points=await root().evaluate(element=>{
            const row=element.querySelector(".st-viewport-row");if(!row)throw new Error("Pointer gesture requires its captured row.");
            const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
            /** @type {Text[]} */ const nodes=[];let n;while(n=walker.nextNode())nodes.push(/** @type {Text} */ (n));
            /** @param {number} offset */
            const locate=offset=>{for(const node of nodes){if(offset<=node.length)return {node,offset};offset-=node.length;}throw new Error("Missing row offset.");};
            /** @param {number} offset */
            const point=offset=>{const a=locate(offset),b=locate(offset+1),r=document.createRange();r.setStart(a.node,a.offset);r.setEnd(b.node,b.offset);const p=r.getBoundingClientRect();return {x:p.left+p.width*.25,y:p.top+p.height*.5};};
            element.dataset.pointerId="";element.dataset.pointerGot="0";element.dataset.pointerLost="0";
            element.addEventListener("pointerdown",e=>element.dataset.pointerId=String(/** @type {PointerEvent} */ (e).pointerId));element.addEventListener("gotpointercapture",()=>element.dataset.pointerGot=String(Number(element.dataset.pointerGot)+1));element.addEventListener("lostpointercapture",()=>element.dataset.pointerLost=String(Number(element.dataset.pointerLost)+1));
            return {start:point(2),hover:point(8)};
        });
        if(iteration===0)displays.push({host,corpus,cancellation,...await root().evaluate(node=>{const s=getComputedStyle(node);return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,fontStyle:s.fontStyle,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,width:node.clientWidth,height:node.clientHeight,devicePixelRatio};})});
        const before=await snapshot(),setupSaveExports=before.source.exports;assert.ok(before.bindings.comparison,"Pointer gesture requires its comparison view.");assert.equal(setupSaveExports,1);assert.equal(before.source.dirty,false);assert.equal(before.bindings.comparison.referenceIsWorkingBuffer,false);
        activeCase.stage="gesture";const workflowStart=performance.now();await page.mouse.move(points.start.x,points.start.y);await page.mouse.down();await page.mouse.move(points.start.x+.5,points.start.y);
        await page.waitForFunction(()=>Number(document.querySelector('textarea[aria-label="Primary source"]')?.closest(".st-editor")?.getAttribute("data-pointer-got"))>0);
        const pointer=Number(await root().getAttribute("data-pointer-id"));assert.equal(await root().evaluate((node,id)=>node.hasPointerCapture(id),pointer),true);
        if(cancellation==="capture-loss")await root().evaluate((node,id)=>node.releasePointerCapture(id),pointer);
        else await root().evaluate((node,id)=>node.dispatchEvent(new PointerEvent("pointercancel",{pointerId:id,bubbles:true})),pointer);
        assert.equal(await root().evaluate((node,id)=>node.hasPointerCapture(id),pointer),false);
        await page.mouse.move(10,10);await page.mouse.up();await page.waitForFunction(()=>Number(document.querySelector('textarea[aria-label="Primary source"]')?.closest(".st-editor")?.getAttribute("data-pointer-lost"))>0);
        await page.mouse.move(points.hover.x,points.hover.y);await ready();const gestureActionProxyMs=performance.now()-workflowStart,retained=await snapshot(),primary=retained.bindings.views.find(v=>v.id==="primary");
        assert.ok(primary,"Pointer gesture requires its retained primary view.");assert.equal(primary.selection.anchor,2);assert.equal(primary.selection.head,2);assert.equal(retained.source.revision,before.source.revision);assert.deepEqual(retained.history,before.history);
        assert.equal(retained.source.exports,setupSaveExports);
        const secondary=retained.bindings.views.find(v=>v.id==="secondary"),beforeSecondary=before.bindings.views.find(v=>v.id==="secondary");assert.ok(secondary&&beforeSecondary&&retained.bindings.comparison,"Pointer gesture requires its independent views.");
        assert.deepEqual(secondary.selection,beforeSecondary.selection);assert.deepEqual(retained.bindings.comparison.selection,before.bindings.comparison.selection);
        const input=page.getByRole("textbox",{name:"Primary source",exact:true});assert.equal(await input.evaluate(node=>node.ownerDocument.activeElement===node),true);
        activeCase.stage="typing";await page.evaluate(()=>window.hostReferenceProbe.arm({kind:"input",text:"q"}));
        /** @type {number | undefined} */ let inputStart;
        const history=await typeHostSuffix(input,"q",()=>{inputStart=performance.now();return page.keyboard.type("q");});const observation=await page.evaluate(()=>window.hostReferenceProbe.read());
        const inputEnd=performance.now(),workflowActionProxyMs=performance.now()-workflowStart;assert.ok(inputStart!==undefined,"Pointer workflow requires its actual input start.");
        const point=Object.assign(observation,{completeActionProxyMs:inputEnd-inputStart}),after=await snapshot(),expected=original.slice(0,2)+"q"+original.slice(2);assert.ok(after.bindings.comparison,"Typed pointer workflow requires its comparison view.");
        assert.equal(await exact(expected),true);assert.equal(after.source.revision,retained.source.revision+1);assert.equal(after.source.exports,0);assert.equal(after.source.dirty,true);assert.equal(after.source.serverVersion,"v1");
        assert.equal(point.primarySelection.head,3);assert.equal(point.primarySelection.anchor,3);assert.deepEqual(point.secondarySelection,{anchor:5,head:1,anchorAffinity:"before",headAffinity:"after"});
        assert.equal(after.bindings.comparison.selection.anchor,11);assert.equal(after.bindings.comparison.selection.head,13);assert.equal(point.referenceVersion,"reference:saved-v1");assert.equal(point.referenceIsWorkingBuffer,false);
        assert.equal(point.records.length,1);assert.equal(point.generations.length,1);assert.ok(point.hunks>0);assert.ok(point.rows.every(n=>n<100));assert.ok(point.readUnits.every(n=>n<20000));assert.ok(point.inputUnits.every(n=>n<=2600));assert.ok(point.comparisonInputUnits<=2600);
        assert.equal(after.history.undoDepth,retained.history.undoDepth+1);assert.equal(after.activity.writes,1);assert.ok(after.activity.background>before.activity.background);
        activeCase.stage="history";await input.press("Control+z");await ready();assert.equal(await exact(original),true);assert.equal((await snapshot()).source.dirty,false);
        await input.press("Control+Shift+z");await ready();assert.equal(await exact(expected),true);assert.equal((await snapshot()).source.dirty,true);
        if(iteration>=warmup)samples.push({iteration,setupSaveExports,gestureExportDelta:retained.source.exports-setupSaveExports,gestureActionProxyMs,workflowActionProxyMs,point,history,backgroundUpdates:after.activity.background-before.activity.background,revision:after.source.revision});await dispose();
    }
    const summary={host,editor:"candidate",corpus,cancellation,length:original.length,warmup,measured,samples,inputHandlerMs:distribution(samples.map(s=>{const ms=s.point.records[0]?.inputHandlerMs;assert.ok(ms!==undefined&&ms!==null,"Pointer input requires its handler clock.");return ms;})),
        pointInputToReviewReadyProxyMs:distribution(samples.map(s=>{const ms=s.point.lastInputToFullReviewReadyProxyMs;assert.ok(ms!==null,"Pointer input requires its readiness clock.");return ms;})),completePointActionProxyMs:distribution(samples.map(s=>s.point.completeActionProxyMs)),
        gestureActionProxyMs:distribution(samples.map(s=>s.gestureActionProxyMs)),workflowActionProxyMs:distribution(samples.map(s=>s.workflowActionProxyMs))};
    const targets={handlerMs:16,pointReadyMs:corpus==="unicode-crlf"?100:250,completePointActionMs:corpus==="unicode-crlf"?200:500};
    const item={...summary,targets,assessment:{handlerMet:summary.inputHandlerMs.p95<=targets.handlerMs,pointReadyMet:summary.pointInputToReviewReadyProxyMs.p95<=targets.pointReadyMs,completePointActionMet:summary.completePointActionProxyMs.p95<=targets.completePointActionMs}};cases.push(item);
    console.log(JSON.stringify({host,corpus,cancellation,measured,handlerP95:item.inputHandlerMs.p95,pointReadyP95:item.pointInputToReviewReadyProxyMs.p95,workflowP95:item.workflowActionProxyMs.p95}));
}assert.equal(cases.length,8);assert.deepEqual(h.errors,[]);assert.equal((await sourceIdentity()).sha256,source.sha256);await mkdir(directory,{recursive:true});
await writeFile(`${directory}/${smoke?"smoke":"latest"}.json`,JSON.stringify({schemaVersion:1,source,created:new Date().toISOString(),smoke,environment:{...environment(),browser:h.browser.version(),buildMode:h.buildMode,displays},cases,errors:h.errors,
    boundaries:"Both candidatehosts,UnicodeCRLF/100k,realmouse capture loss and explicitlysyntheticownedcancel. Actualgotcapture precedescancellation; releaseoutsideandhover mustleavecaret/history/independentselections unchanged. Actualq insertsatcapturedcaret,sharedhistoryundostosaved/redo/baselineversions/bounds/export/disposal asserted. Initialsave/reference/setup excluded. Adapterduration includes synchronoussubscribers,excludesbeforeinput/native-before-handler/laterprobelisteners. Pointreadiness startsbeforeinput,waitscurrentpanes/scans/caret/comparison/referenceversion+2frames. Completepointaction includesautomation. Wholegesture/workflow includescapture/cancellation/outside release/hoversettlement andq; no pointbudget forwholegesture. No imposed servicedelay. Rawp50/p95/max preserved,requestedfontfields distinctfrominstalled-fontidentity; framesare notphysicaldisplay andsyntheticcancel isnotnative deviceproof. No nativeIME/OSclipboard qualification."},null,2));
}catch(error){await mkdir(directory,{recursive:true});await writeFile(`${directory}/failure-${Date.now()}.json`,JSON.stringify({source,smoke,activeCase,error:String(error),stack:error instanceof Error?error.stack:undefined,completed:cases,state:scene.mounted?await snapshot().catch(()=>null):null,errors:h.errors},null,2));throw error;
}finally{await dispose().catch(()=>{});await h.close();}
