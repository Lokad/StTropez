import { expect, test } from "./fixtures.ts";
import { fontFixture } from "../fixtures/consumer/font-fixture.ts";

test.beforeEach(async ({ page }) => {

    await page.goto("/fonts/");
    await page.waitForFunction(() => window.nativeFontFixture?.ready);
});

test("native font registration copies bytes and expires superseded generations on insecure origins", async ({ page }) => {
    const source = page.url();
    await page.route("http://font-fixture.test/**", async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await page.request.get(new URL(url.pathname + url.search, source).href) });
    });
    await page.goto("http://font-fixture.test/fonts/");
    await page.waitForFunction(() => window.nativeFontFixture?.ready);
    const result = await page.evaluate(async () => {
        const f = window.nativeFontFixture, subscribe = f.asset.subscribe, observed: string[] = [];
        const stop = subscribe(() => { const s = f.asset.getSnapshot(); observed.push(`${s.generation}:${s.status}`); });
        const first = f.request(), second = f.request(800), results = await Promise.all([first.settled, second.settled]);
        const state = f.asset.getSnapshot(), context = document.createElement("canvas").getContext("2d")!;
        context.font = `100px ${state.current!.family}`;
        const width = context.measureText("A").width, rejected = f.asset.request(0, new Uint8Array());
        stop();
        return { results, observed, width, rejected, unchanged: state === f.asset.getSnapshot(),
            stable: subscribe === f.asset.subscribe, current: f.asset.isCurrent(2), old: f.asset.isCurrent(1),
            secure: isSecureContext, uuid: typeof crypto.randomUUID };
    });
    expect(result.results).toEqual([{ generation: 1, status: "stale" }, { generation: 2, status: "ready" }]);
    expect(result.observed).not.toContain("1:ready");
    expect(result.width).toBeCloseTo(80, 1);
    expect(result).toMatchObject({ rejected: null, unchanged: true, stable: true, current: true, old: false, secure: false, uuid: "undefined" });
});

test("failed native decoding preserves the registered font and foreign faces", async ({ page, browserName, browserErrors }) => {
    // Give only the deliberately rejected face a deterministic name for exact native diagnostics.
    const family = `_stfont_${"0".repeat(32)}`;
    if (browserName === "firefox") for (const reason of ["rejected by sanitizer", "font load failed"])
        browserErrors.allowConsoleError(`[JavaScript Error: "downloadable font: ${reason} (font-family: "${family}" style:normal weight:400 width:100 src index:0) source: (invalid URI)"]`, "");
    const result = await page.evaluate(async bytes => {
        const f = window.nativeFontFixture, foreign = new FontFace("HostExistingFixture", new Uint8Array(bytes));
        await foreign.load(); document.fonts.add(foreign);
        try {
            await f.request().settled;
            const active = f.asset.getSnapshot().current!;
            const random = crypto.getRandomValues;
            crypto.getRandomValues = array => {
                if (!(array instanceof Uint32Array) || array.length !== 4) throw new Error("Unexpected fault-injection nonce.");
                array.fill(0); return array;
            };
            let rejected;
            try { rejected = f.asset.request(f.asset.getSnapshot().generation, new Uint8Array())!; }
            finally { crypto.getRandomValues = random; }
            const failed = await rejected.settled;
            return { failed, status: f.asset.getSnapshot().status, same: active === f.asset.getSnapshot().current,
                current: f.asset.isCurrent(active.generation), foreign: document.fonts.has(foreign) };
        } finally { document.fonts.delete(foreign); f.asset.dispose(); }
    }, Array.from(fontFixture()));
    expect(result.failed.status).toBe("failed");
    expect(result).toMatchObject({ status: "failed", same: true, current: true, foreign: true });
});

test("cancel and disposal prevent late native font registration", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const f = window.nativeFontFixture;
        const faces = () => [...document.fonts].filter(face => face.family.startsWith("_stfont_")).length;
        await f.request().settled;
        const old = f.asset.getSnapshot().current!, pending = f.request(800);
        f.asset.cancel();
        const cancelled = await pending.settled, afterCancel = { current: f.asset.isCurrent(old.generation), faces: faces() };
        const late = f.request(700); f.asset.dispose(); f.asset.dispose();
        return { cancelled, afterCancel, late: await late.settled, state: f.asset.getSnapshot(), faces: faces(), oldCurrent: f.asset.isCurrent(old.generation) };
    });
    expect(result.cancelled.status).toBe("stale");
    expect(result.afterCancel).toEqual({ current: true, faces: 1 });
    expect(result.late.status).toBe("disposed");
    expect(result.state).toMatchObject({ status: "disposed", current: null });
    expect(result.faces).toBe(0); expect(result.oldCurrent).toBe(false);
});
