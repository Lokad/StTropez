import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import {openHarness} from "./browser-harness.mjs";
import {sourceIdentity,environment,distribution as measuredDistribution} from "./measurement.mjs";
import {installHostReferenceProbe} from "./host-reference-probe.mjs";
import {typeHostSuffix} from "./host-typing.mjs";

const source=await sourceIdentity(),smoke=process.env.STTROPEZ_SAVE_RECOVERY_SMOKE==="1",retentionCheck=process.argv.includes("--retention-check"),warmup=retentionCheck?2:smoke?0:3,measured=smoke||retentionCheck?1:10;
assert.ok(!smoke||!retentionCheck,"Select smoke or retention check.");
const distribution=values=>({...measuredDistribution(values),max:Math.max(...values)});
const harness=await openHarness(),page=harness.page,cases=[],warmupCases=[],displays=[],directory="artifacts/bench/save-recovery";
const snapshot=()=>page.evaluate(()=>window.hostFixture.snapshot()),click=name=>page.getByRole("button",{name,exact:true}).click();
const ready=()=>page.evaluate(()=>globalThis.hostReferenceProbe.waitReady());
const fullText=expected=>page.evaluate(expected=>{const f=window.hostFixture;return f.snapshot().source.length===expected.length&&f.range(0,expected.length)===expected;},expected);
let activeCase,activeSample,activeSamples,mounted=false;
async function dispose(){if(!mounted)return;await page.evaluate(()=>window.hostFixture.dispose());mounted=false;const s=await snapshot();
    assert.equal(s.diagnostics.views,0);assert.equal(s.diagnostics.leases,0);assert.equal(s.diagnostics.subscriptions,0);assert.equal(s.hostSubscriptions,0);assert.equal(s.pendingCommands,0);}
try{
    for(const host of ["plain","react"])for(const corpus of retentionCheck?["unicode-crlf"]:["unicode-crlf","lines-100000","unique-lines-100000","single-line"]){
        const line="const sample = 1234567;",original=corpus==="unicode-crlf"?Array(60).fill("const café = 'é 👩‍💻 東京';").join("\r\n")
            :corpus==="single-line"?"x".repeat(2400000):corpus==="unique-lines-100000"?Array.from({length:100000},(_,i)=>`const value${String(i).padStart(6,"0")} = 123;`).join("\n")
            :Array(100000).fill(line).join("\n");
        const samples=[],warmupSamples=[];activeSamples={observed:samples,warmup:warmupSamples};
        for(let iteration=0;iteration<warmup+measured;iteration++){
            activeCase={host,corpus,iteration,phase:iteration<warmup?"warmup":"observation",stage:"setup"};activeSample={iteration,phase:activeCase.phase};await dispose();await page.goto(new URL(`/hosts/${host}/?editor=candidate`,page.url()).href);
            await page.waitForFunction(()=>window.hostFixture?.snapshot().bindings.activeViews===2);mounted=true;
            await page.evaluate(installHostReferenceProbe);await click("Open source review");await ready();
            await page.evaluate(text=>{const f=window.hostFixture,s=f.snapshot();f.editSource(s.source.revision,[{from:0,to:s.source.length,insert:text}]);},original);
            await click("Save source");await page.waitForFunction(()=>window.hostFixture.snapshot().pendingSaves.length===1);
            await page.evaluate(()=>window.hostFixture.finishSave());await page.waitForFunction(()=>window.hostFixture.snapshot().pendingCommands===0);
            await click("Capture reference refresh");await click("Finish reference refresh");await ready();
            const initial=await snapshot();assert.equal(initial.source.serverVersion,"v1");assert.equal(initial.source.dirty,false);
            assert.equal(initial.bindings.comparison.referenceIsWorkingBuffer,false);assert.equal(await fullText(original),true);
            const input=page.getByRole("textbox",{name:"Primary source",exact:true});await input.press("Control+End");await ready();
            if(iteration===0)displays.push({host,corpus,...await input.evaluate(node=>{const root=node.closest(".st-viewport"),style=getComputedStyle(root);
                return {font:style.font,width:root.clientWidth,height:root.clientHeight,devicePixelRatio};})});
            assert.equal(await page.evaluate(()=>{const f=window.hostFixture;return f.selectSource("secondary",f.snapshot().source.revision,{anchor:4,head:1});}),true);
            const workflowStart=performance.now();activeCase.stage="capture";await typeHostSuffix(input," corrected");
            let start=performance.now();await click("Save source");await page.waitForFunction(()=>window.hostFixture.snapshot().pendingSaves.length===1);
            const captureActionProxyMs=performance.now()-start,submitted=(await snapshot()).pendingSaves[0];activeSample.capture={captureActionProxyMs,submitted};
            await input.press("Control+End");await input.press("ArrowLeft");await input.press("ArrowRight");await typeHostSuffix(input," later");await ready();
            // Deliberate navigation starts a distinct history gesture,matching the existing input campaigns.
            await input.press("ArrowLeft");await input.press("ArrowRight");await ready();const before=await snapshot();
            const atFailure=original+" corrected later",retryValue=atFailure+"q",expected=retryValue+" newest";
            assert.equal(await fullText(atFailure),true);assert.equal(before.source.exports,0);
            assert.equal(before.pendingSaves[0].revision,submitted.revision);
            await page.evaluate(()=>globalThis.hostReferenceProbe.arm({kind:"input",text:"q"}));
            activeCase.stage="failure";const failureStart=performance.now();
            const failureBrowserStart=await page.evaluate(()=>{const at=performance.now();window.hostFixture.failSave();return at;});
            let inputStart;const pointHistory=await typeHostSuffix(input,"q",()=>{inputStart=performance.now();return page.keyboard.type("q");});
            const point=await page.evaluate(()=>globalThis.hostReferenceProbe.read());point.completeActionProxyMs=performance.now()-inputStart;activeSample.point=point;
            const failureBrowserFinish=await page.evaluate(async()=>{
                const s=window.hostFixture.snapshot();if(s.source.saveStatus!=="failed"||s.pendingCommands!==0
                    ||!document.querySelector('[aria-label="Host messages"]').textContent.includes("Your document is retained"))throw new Error("Missing visible failed-save outcome.");
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return performance.now();
            });
            const failureWithTypingActionProxyMs=performance.now()-failureStart,failureToReviewAndMessageReadyProxyMs=failureBrowserFinish-failureBrowserStart;
            activeSample.failure={failureWithTypingActionProxyMs,failureToReviewAndMessageReadyProxyMs};
            const failed=await snapshot();assert.equal(await fullText(retryValue),true);assert.equal(failed.source.serverVersion,"v1");assert.equal(failed.source.dirty,true);
            assert.equal(failed.activity.writes,1);assert.equal(failed.activity.errors,1);assert.deepEqual(failed.review.acknowledgements,[]);
            assert.deepEqual(failed.server,before.server);assert.deepEqual(failed.bindings.comparison.baseline,before.bindings.comparison.baseline);
            assert.deepEqual(failed.comparisonReference,before.comparisonReference);assert.equal(point.exports,0);assert.equal(point.records.length,1);
            assert.deepEqual(point.secondarySelection,before.bindings.views.find(v=>v.id==="secondary").selection);
            assert.equal(point.referenceVersion,before.bindings.comparison.baseline.version);assert.ok(point.hunks>0);
            assert.ok(point.rows.every(n=>n<100));assert.ok(point.readUnits.every(n=>n<20000));assert.ok(point.inputUnits.every(n=>n<=2600));
            activeCase.stage="retry";start=performance.now();await click("Dismiss message");await click("Save source");
            await page.waitForFunction(()=>window.hostFixture.snapshot().pendingSaves.length===1);
            assert.deepEqual((await snapshot()).pendingSaves,[{revision:failed.source.revision,length:retryValue.length,expectedServerVersion:"v1"}]);
            await input.press("Control+End");await input.press("ArrowLeft");await input.press("ArrowRight");const lateHistory=await typeHostSuffix(input," newest");await ready();
            const retained=(await snapshot()).bindings.views.map(v=>({id:v.id,selection:v.selection}));
            await page.evaluate(()=>window.hostFixture.unmount());await page.evaluate(()=>window.hostFixture.mount());await ready();
            assert.deepEqual((await snapshot()).bindings.views.map(v=>({id:v.id,selection:v.selection})),retained);await input.focus();
            await page.evaluate(()=>window.hostFixture.finishSave());await page.waitForFunction(()=>{const s=window.hostFixture.snapshot();return s.pendingCommands===0&&s.source.serverVersion==="v2";});await ready();
            const retryWithLateTypingRemountActionProxyMs=performance.now()-start,saved=await snapshot();activeSample.retry={retryWithLateTypingRemountActionProxyMs};
            assert.equal(await fullText(expected),true);assert.equal(saved.source.dirty,true);assert.equal(saved.activity.writes,2);assert.equal(saved.activity.lastSavedRevision,failed.source.revision);
            assert.equal(await input.evaluate(node=>node.ownerDocument.activeElement===node),true);
            activeCase.stage="reference";start=performance.now();await click("Capture reference refresh");await click("Finish reference refresh");await ready();
            const referenceRefreshActionProxyMs=performance.now()-start,workflowActionProxyMs=performance.now()-workflowStart;activeSample.reference={referenceRefreshActionProxyMs,workflowActionProxyMs};
            assert.equal(await page.evaluate(text=>window.hostFixture.referenceRange(0,text.length)===text,retryValue),true);
            const final=await snapshot();assert.equal(final.bindings.comparison.baseline.version,"reference:saved-v2");
            assert.equal(final.bindings.comparison.baseline.length,retryValue.length);assert.ok(final.bindings.comparison.hunks>0);assert.equal(final.source.exports,0);
            activeCase.stage="history";for(let i=0;i<lateHistory.groups;i++)await input.press("Control+z");await ready();assert.equal(await fullText(retryValue),true);assert.equal((await snapshot()).source.dirty,false);
            for(let i=0;i<lateHistory.groups;i++)await input.press("Control+Shift+z");await ready();assert.equal(await fullText(expected),true);assert.equal((await snapshot()).source.dirty,true);
            (iteration>=warmup?samples:warmupSamples).push({iteration,captureActionProxyMs,failureWithTypingActionProxyMs,failureToReviewAndMessageReadyProxyMs,
                retryWithLateTypingRemountActionProxyMs,referenceRefreshActionProxyMs,workflowActionProxyMs,point,pointHistory,lateHistory,
                revisions:{submitted:submitted.revision,atFailure:before.source.revision,retry:failed.source.revision,final:final.source.revision},backgroundUpdates:final.activity.background-initial.activity.background});
            await dispose();
        }
        assert.equal(samples.length,measured);assert.equal(warmupSamples.length,warmup);
        if(warmupSamples.length)warmupCases.push({host,editor:"candidate",corpus,length:original.length,warmup,measured,samples:warmupSamples});
        const handlerValues=samples.flatMap(s=>s.point.records.map(r=>r.inputHandlerMs)),large=original.length>100000;
        const item={host,editor:"candidate",corpus,length:original.length,warmup,measured,samples,inputHandlerMs:distribution(handlerValues),
            pointInputToReviewReadyProxyMs:distribution(samples.map(s=>s.point.lastInputToFullReviewReadyProxyMs)),completePointInputActionProxyMs:distribution(samples.map(s=>s.point.completeActionProxyMs))};
        for(const key of ["captureActionProxyMs","failureWithTypingActionProxyMs","failureToReviewAndMessageReadyProxyMs","retryWithLateTypingRemountActionProxyMs","referenceRefreshActionProxyMs","workflowActionProxyMs"])item[key]=distribution(samples.map(s=>s[key]));
        item.targets={inputHandlerMs:16,pointReadyMs:large?250:100,completePointActionMs:large?500:200};
        item.assessment={handlerMet:item.inputHandlerMs.p95<=item.targets.inputHandlerMs,pointReadyMet:item.pointInputToReviewReadyProxyMs.p95<=item.targets.pointReadyMs,
            completePointActionMet:item.completePointInputActionProxyMs.p95<=item.targets.completePointActionMs};cases.push(item);
        console.log(JSON.stringify({host,corpus,measured,semanticChecks:"passed",handlerP95:item.inputHandlerMs.p95,pointReadyP95:item.pointInputToReviewReadyProxyMs.p95,failureReadyP95:item.failureToReviewAndMessageReadyProxyMs.p95,workflowP95:item.workflowActionProxyMs.p95}));
    }
    assert.equal(cases.length,retentionCheck?2:8);assert.equal(warmupCases.length,warmup?cases.length:0);assert.deepEqual(harness.errors,[]);assert.equal((await sourceIdentity()).sha256,source.sha256);
    await mkdir(directory,{recursive:true});await writeFile(`${directory}/${retentionCheck?"retention-check":smoke?"smoke":"latest"}.json`,JSON.stringify({schemaVersion:1,created:new Date().toISOString(),source,smoke,retentionCheck,diagnosticOnly:smoke||retentionCheck,
        retention:{warmupWorkflows:warmupCases.reduce((n,c)=>n+c.samples.length,0),observedWorkflows:cases.reduce((n,c)=>n+c.samples.length,0),
            warmupPointInputs:warmupCases.reduce((n,c)=>n+c.samples.reduce((m,s)=>m+s.point.records.length,0),0),observedPointInputs:cases.reduce((n,c)=>n+c.samples.reduce((m,s)=>m+s.point.records.length,0),0)},
        environment:{...environment(),browser:harness.browser.version(),displays},cases,warmupCases,errors:harness.errors,
        boundaries:"Both bounded candidate hosts;normal Unicode/CRLF,repeated/distinct100k andlong-line. Existing native adapters retain browser semantic coverage,not candidate handler claims. Initial successful save/reference setup is excluded. Recovery workflow begins before real corrections and includes captured save,later typing,service rejection,real q input,retry,newest typing,remount,receipt and explicit reference refresh. q beforeinput-to-full-review andadapter input-event duration reuse hostReferenceProbe;beforeinput/native/observer work excluded from adapter duration. Complete point action begins at q automation. Failure-to-review/message waits point readiness,visible failed status andtwo additional frames;complete failure action includes automation. Whole workflow/capture/retry/reference clocks remain separate withno point budgets or imposed service delay. Semantic full-text/history checks run outside recorded workflow/action intervals wherepossible;intermediate assertions/transport inside workflow remain included. Raw observed samples,max,p50,p95 and20Hzbackground counts retained. Raw warmups stay separately inwarmupCases andnever enter measured distributions/assessments. The retention check usesboth existingnormal-source controls with2warmups/1observation,marksdiagnosticOnly andwritesretention-check.json;it isreport validation,not point qualification. Point-input counts donot count every other key in thewhole workflow. Available partial stage clocks andcurrent-condition raw samples survive failures. Scheduled frames do not establish physical display; native IME/reconversion,OSclipboard andAT unverified. Prior source/results are not replaced."},null,2));
}catch(error){const failureId=Date.now();await mkdir(directory,{recursive:true});await writeFile(`${directory}/failure-${failureId}.json`,JSON.stringify({source,smoke,retentionCheck,warmup,measured,activeCase,activeSample,activeSamples,error:String(error),stack:error.stack,completed:cases,completedWarmups:warmupCases,
    state:mounted?await snapshot().catch(()=>null):null,errors:harness.errors},null,2));
    if(mounted)await page.screenshot({path:`${directory}/failure-${failureId}.png`,fullPage:true}).catch(()=>{});throw error;
}finally{await dispose().catch(()=>{});await harness.close();}
