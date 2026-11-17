import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import {openHarness} from "./browser-harness.mjs";
import {sourceIdentity,environment,distribution as measuredDistribution} from "./measurement.mjs";
import {createHostScene} from "./host-scene.mjs";

const source=await sourceIdentity(),smoke=process.env.STTROPEZ_DRAG_SMOKE==="1",warmup=smoke?0:3,measured=smoke?1:10,holdFrames=8;
const directory="artifacts/bench/host-drag-scroll",cases=[],displays=[],h=await openHarness(),page=h.page,scene=createHostScene(page);let activeCase;
const distribution=values=>({...measuredDistribution(values),max:Math.max(...values)});
const snapshot=scene.snapshot,primary=s=>s.bindings.views.find(v=>v.id==="primary");
const input=()=>page.getByRole("textbox",{name:"Primary source",exact:true}),root=()=>page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
const click=name=>page.getByRole("button",{name,exact:true}).click(),ready=scene.ready;
const exact=scene.exactText;
async function dispose(){if(!scene.mounted)return;await page.mouse.up();await scene.dispose();}
async function prepare(host,corpus,sign){
    await dispose();await scene.mount(host);
    const line="const sample = '😀 é';",count=corpus==="unicode-crlf"?60:100000,original=corpus==="single-line"?"x".repeat(2400000):Array(count).fill(line).join("\r\n");
    await page.evaluate(text=>{const f=window.hostFixture,s=f.snapshot();f.editSource(s.source.revision,[{from:0,to:s.source.length,insert:text}]);f.selectSource("secondary",f.snapshot().source.revision,{anchor:4,head:1});},original);
    await click("Open source review");await ready();await click("Save source");await page.waitForFunction(()=>window.hostFixture.snapshot().pendingSaves.length===1);await page.evaluate(()=>window.hostFixture.finishSave());
    await page.waitForFunction(()=>window.hostFixture.snapshot().pendingCommands===0&&window.hostFixture.snapshot().source.serverVersion==="v1");await click("Capture reference refresh");await click("Finish reference refresh");await ready();
    const offset=corpus==="single-line"?1200000:sign<0?Math.floor(count/2)*(line.length+2):0;await input().press("Control+Home");
    if(offset){await page.evaluate(offset=>{const f=window.hostFixture;f.selectSource("primary",f.snapshot().source.revision,{anchor:offset,head:offset});},offset);await input().press("ArrowRight");await input().press("ArrowLeft");await ready();}
    await root().scrollIntoViewIfNeeded();return original;
}
async function armGesture(axis,sign){
    return root().evaluate((element,{axis,sign})=>{
        const box=element.getBoundingClientRect(),left=box.left+element.clientLeft,top=box.top+element.clientTop,right=left+element.clientWidth,bottom=top+element.clientHeight;
        const rows=[...element.querySelectorAll(".st-viewport-row")].filter(row=>{const r=row.getBoundingClientRect();return r.top>=top&&r.bottom<=bottom;}),row=rows[Math.min(2,rows.length-1)];if(!row)throw new Error("Missing visible drag row.");
        const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),nodes=[];let node;while(node=walker.nextNode())nodes.push(node);
        const locate=offset=>{for(const node of nodes){if(offset<=node.length)return {node,offset};offset-=node.length;}throw new Error("Missing native drag offset.");};
        const offset=row.dataset.complete==="false"?40:2,a=locate(offset),b=locate(offset+1),range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);const r=range.getBoundingClientRect();
        const point={x:r.left+r.width*.25,y:r.top+r.height*.5,offset:Number(row.dataset.from)+offset,outsideX:axis==="x"?sign>0?right+32:left-32:r.left+r.width*.25,outsideY:axis==="y"?sign>0?bottom+32:top-32:r.top+r.height*.5};
        const listeners=new AbortController(),signal=listeners.signal,state={point,got:0,frames:[],pointer:null,downAt:null,outsideAt:null,upAt:null,allTrusted:true};let frame;
        const observe=time=>{if(state.outsideAt!==null){const s=window.hostFixture.snapshot(),v=s.bindings.views.find(v=>v.id==="primary");state.frames.push({at:time,scrollTop:v.metrics.viewport.scrollTop,scrollLeft:v.metrics.viewport.scrollLeft,selection:v.selection,pendingDragScroll:v.metrics.pendingDragScroll});}frame=requestAnimationFrame(observe);};frame=requestAnimationFrame(observe);
        element.addEventListener("pointerdown",e=>{state.pointer=e.pointerId;state.downAt=performance.now();state.allTrusted&&=e.isTrusted;},{signal});
        element.addEventListener("gotpointercapture",()=>state.got++,{signal});
        element.addEventListener("pointermove",e=>{if(e.pointerId===state.pointer&&(e.buttons&1)&&(e.clientX<left||e.clientX>=right||e.clientY<top||e.clientY>=bottom)){state.outsideAt??=performance.now();state.allTrusted&&=e.isTrusted;}},{capture:true,signal});
        element.addEventListener("pointerup",e=>{if(e.pointerId===state.pointer){state.upAt=performance.now();state.allTrusted&&=e.isTrusted;}},{capture:true,signal});
        globalThis.dragGestureProbe={state,stop:()=>{listeners.abort();cancelAnimationFrame(frame);return state;}};return point;
    },{axis,sign});
}
async function nativeHead(point){
    return root().evaluate((element,point)=>{
        const box=element.getBoundingClientRect(),x=Math.max(box.left+element.clientLeft,Math.min(box.left+element.clientLeft+element.clientWidth-1,point.outsideX)),y=Math.max(box.top+element.clientTop,Math.min(box.top+element.clientTop+element.clientHeight-1,point.outsideY));
        const rows=[...element.querySelectorAll(".st-viewport-row")].map(row=>({row,rect:row.getBoundingClientRect()})).sort((a,b)=>Math.max(a.rect.top-y,y-a.rect.bottom,0)-Math.max(b.rect.top-y,y-b.rect.bottom,0));
        const row=rows[0].row,walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);let node,offset=Number(row.dataset.from),nearest=null;
        while(node=walker.nextNode()){for(let i=0;i<=node.length;i++){const r=document.createRange();r.setStart(node,i);r.collapse(true);const rect=r.getBoundingClientRect(),distance=Math.abs(rect.left-x);if(!nearest||distance<nearest.distance)nearest={offset:offset+i,distance};}offset+=node.length;}
        if(!nearest)throw new Error("Missing native caret oracle.");return nearest.offset;
    },point);
}
try{
    for(const host of ["plain","react"])for(const corpus of ["unicode-crlf","lines-100000","single-line"])for(const sign of [1,-1]){
        const axis=corpus==="single-line"?"x":"y",samples=[];
        for(let iteration=0;iteration<warmup+measured;iteration++){
            activeCase={host,corpus,axis,sign,iteration,stage:"setup"};const original=await prepare(host,corpus,sign),point=await armGesture(axis,sign),initial=await snapshot(),scrollKey=axis==="x"?"scrollLeft":"scrollTop";
            assert.equal(initial.source.exports,1);assert.equal(initial.source.dirty,false);if(axis==="x")assert.ok(primary(initial).metrics.viewport.horizontalExtent>primary(initial).metrics.viewport.physicalWidth);
            if(iteration===0)displays.push({host,corpus,axis,sign,...await root().evaluate(node=>{const s=getComputedStyle(node);return {fontFamily:s.fontFamily,fontSize:s.fontSize,lineHeight:s.lineHeight,width:node.clientWidth,height:node.clientHeight,devicePixelRatio};})});
            activeCase.stage="gesture";const workflowStart=performance.now();await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+.5,point.y);await page.waitForFunction(()=>globalThis.dragGestureProbe.state.got>0);
            const down=await snapshot();assert.equal(primary(down).selection.anchor,point.offset);assert.equal(primary(down).selection.head,point.offset);
            await page.mouse.move(point.outsideX,point.outsideY);await page.evaluate(count=>new Promise(resolve=>{const step=()=>{if(--count)requestAnimationFrame(step);else resolve();};requestAnimationFrame(step);}),holdFrames);await page.mouse.up();
            const readyAt=await page.evaluate(async()=>{await globalThis.hostReferenceProbe.waitReady();return performance.now();}),gestureActionProxyMs=performance.now()-workflowStart,gesture=await page.evaluate(()=>globalThis.dragGestureProbe.stop()),released=await snapshot();
            assert.equal(gesture.allTrusted,true);assert.ok(gesture.outsideAt!==null&&gesture.upAt>gesture.outsideAt);assert.ok(gesture.frames.length>=holdFrames);assert.ok(primary(released).metrics.dragScrollFrames>0);assert.equal(primary(released).metrics.pendingDragScroll,false);
            assert.equal(Math.sign(primary(released).metrics.viewport[scrollKey]-primary(initial).metrics.viewport[scrollKey]),sign);assert.equal(primary(released).selection.anchor,point.offset);
            const expectedHead=await nativeHead(point);assert.equal(primary(released).selection.head,expectedHead);assert.equal(released.source.revision,initial.source.revision);assert.deepEqual(released.history,initial.history);assert.equal(released.source.exports,initial.source.exports);
            assert.deepEqual(released.bindings.views.find(v=>v.id==="secondary").selection,initial.bindings.views.find(v=>v.id==="secondary").selection);assert.deepEqual(released.bindings.comparison.selection,initial.bindings.comparison.selection);assert.equal(released.bindings.mounts,initial.bindings.mounts);
            const from=Math.min(point.offset,expectedHead),to=Math.max(point.offset,expectedHead);assert.ok(from<to);assert.equal(await input().evaluate(node=>node.ownerDocument.activeElement===node),true);
            activeCase.stage="typing";await page.evaluate(()=>globalThis.hostReferenceProbe.arm({kind:"input",text:"q",replaceSelection:true}));const pointStart=performance.now();await page.keyboard.type("q");
            const observed=await page.evaluate(()=>globalThis.hostReferenceProbe.read());observed.completeActionProxyMs=performance.now()-pointStart;const workflowActionProxyMs=performance.now()-workflowStart;
            const expected=original.slice(0,from)+"q"+original.slice(to),final=await snapshot();assert.equal(await exact(expected),true);assert.deepEqual(observed.replacement,{from,to});assert.equal(observed.primarySelection.anchor,from+1);assert.equal(observed.primarySelection.head,from+1);
            assert.equal(observed.records.length,1);assert.equal(observed.generations.length,1);assert.equal(observed.exports,0);assert.equal(observed.referenceVersion,"reference:saved-v1");assert.ok(observed.rows.every(n=>n<100));assert.ok(observed.readUnits.every(n=>n<20000));assert.ok(observed.inputUnits.every(n=>n<=2600));assert.ok(observed.comparisonInputUnits<=2600);
            assert.equal(final.history.undoDepth,initial.history.undoDepth+1);assert.ok(final.activity.background>initial.activity.background);assert.equal(await scene.exactText(original,"reference"),true);
            activeCase.stage="history";await input().press("Control+z");await ready();assert.equal(await exact(original),true);assert.equal((await snapshot()).source.dirty,false);await input().press("Control+Shift+z");await ready();assert.equal(await exact(expected),true);assert.equal((await snapshot()).source.dirty,true);
            if(iteration>=warmup)samples.push({iteration,gestureActionProxyMs,workflowActionProxyMs,gestureToReviewReadyProxyMs:readyAt-gesture.outsideAt,releaseToReviewReadyProxyMs:readyAt-gesture.upAt,stationaryHoldMs:gesture.upAt-gesture.outsideAt,
                dragFrameMaximumMs:primary(released).metrics.maxDragScrollStepMs,dragScrollFrames:primary(released).metrics.dragScrollFrames,gesture,point:observed,expectedSelection:{anchor:point.offset,head:expectedHead},backgroundUpdates:final.activity.background-initial.activity.background,setupSaveExports:initial.source.exports,gestureExportDelta:released.source.exports-initial.source.exports});
            await dispose();
        }
        const item={host,editor:"candidate",corpus,axis,sign,holdFrames,warmup,measured,samples};for(const key of ["gestureActionProxyMs","workflowActionProxyMs","gestureToReviewReadyProxyMs","releaseToReviewReadyProxyMs","stationaryHoldMs","dragFrameMaximumMs"])item[key]=distribution(samples.map(s=>s[key]));
        item.inputHandlerMs=distribution(samples.flatMap(s=>s.point.records.map(r=>r.inputHandlerMs)));item.pointInputToReviewReadyProxyMs=distribution(samples.map(s=>s.point.lastInputToFullReviewReadyProxyMs));item.completePointActionProxyMs=distribution(samples.map(s=>s.point.completeActionProxyMs));
        const large=corpus!=="unicode-crlf";item.targets={handlerMs:16,frameCallbackMs:16,releaseReadyMs:large?250:100,pointReadyMs:large?250:100,pointActionMs:large?500:200};item.assessment={handlerMet:item.inputHandlerMs.p95<=16,frameCallbackMet:item.dragFrameMaximumMs.p95<=16,releaseReadyMet:item.releaseToReviewReadyProxyMs.p95<=item.targets.releaseReadyMs,pointReadyMet:item.pointInputToReviewReadyProxyMs.p95<=item.targets.pointReadyMs,pointActionMet:item.completePointActionProxyMs.p95<=item.targets.pointActionMs};cases.push(item);
        console.log(JSON.stringify({host,corpus,axis,sign,measured,frameMaximumP95:item.dragFrameMaximumMs.p95,releaseReadyP95:item.releaseToReviewReadyProxyMs.p95,pointReadyP95:item.pointInputToReviewReadyProxyMs.p95,workflowP95:item.workflowActionProxyMs.p95,assessment:item.assessment}));
    }
    assert.equal(cases.length,12);assert.deepEqual(h.errors,[]);assert.equal((await sourceIdentity()).sha256,source.sha256);await mkdir(directory,{recursive:true});
    await writeFile(`${directory}/${smoke?"smoke":"latest"}.json`,JSON.stringify({schemaVersion:1,source,created:new Date().toISOString(),smoke,environment:{...environment(),browser:h.browser.version(),displays},cases,errors:h.errors,
        boundaries:"Both candidate hosts;normalUnicodeCRLF/100k vertical and2.4M ASCII horizontal compressed logical extents,bothdirections. Initialsave/reference/setup excluded. Actual captured mouse,8requestedstationaryanimationframes,outside release,allpanes/reference/scans/caret/no pendingDragScroll+2frames. Native Range caret oracle from bounded rendered text independentlychecks released head. q replaces exact captured selection; source/history/savedref/exports/bounds/background/disposal asserted. Raw gesture browser clocks begin at firstoutside move capture; release clock at pointerup capture. Holdduration is explicit. Full gesture automation begins before initial mouse move/down; workflow includes gesture/oracle/control transport and q. Pointinput beforeinput/readiness/handler andcompletepointaction separate. maxDragScrollStepMs is longest complete synchronous RAFcallback elapsed span per mount,including guards/layout/projection/selection/subscribers/cleanup/scheduling,not a per-frame p95 or processCPU. Report distribution of those per-workflow maxima and raw frame observations. Handler includes synchronoussubscribers;excludesbeforeinput/native-before-handler/laterprobelisteners. Wholegestures/workflows have no point-action budget. No imposed servicedelay,physical display/nativeIME/OSclipboard qualification."},null,2));
}catch(error){await mkdir(directory,{recursive:true});await writeFile(`${directory}/failure-${Date.now()}.json`,JSON.stringify({source,smoke,activeCase,error:String(error),stack:error.stack,completed:cases,state:scene.mounted?await snapshot().catch(()=>null):null,errors:h.errors},null,2));throw error;}
finally{await page.evaluate(()=>globalThis.dragGestureProbe?.stop()).catch(()=>{});await dispose().catch(()=>{});await h.close();}
