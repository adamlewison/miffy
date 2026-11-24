#!/usr/bin/env node
/**
 * Checks Oney behaves like one solid object: for each pose, measures how deep any
 * arm/ear collision sphere sinks into her head, body, legs or arms — before the
 * collision solve (how bad the raw pose is) and after (what you actually see).
 *
 *   node tools/solid.cjs                                  # all poses
 *   node tools/solid.cjs --poses sad,wave --shots .oney-out/solid
 *
 * Exits 1 if any pose is left with more than --max cm of penetration (default 0.5).
 * Env: ONEY_URL (default http://localhost:3000), BUNNY_PASSCODE.
 * Reads window.__oneySolid, exposed by /preview?debug=1 (see collide.ts / GlbBunny.tsx).
 */
const { chromium } = require("playwright");

(async () => {
  const v = process.argv.slice(2);
  const opt = (k, d) => (v.includes(`--${k}`) ? v[v.indexOf(`--${k}`) + 1] : d);
  const poses = opt("poses", "idle,listening,thinking,talking,wave,sad,nuzzle").split(",");
  const shots = opt("shots", "");
  const maxCm = Number(opt("max", "0.5"));
  const base = process.env.ONEY_URL || "http://localhost:3000";

  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 600, height: 820 }, deviceScaleFactor: 1 });
  if (process.env.BUNNY_PASSCODE) await ctx.request.post(`${base}/api/login`, { data: { passcode: process.env.BUNNY_PASSCODE } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`${base}/preview?shells=${opt("shells", "0")}&hold=1&debug=1`);
  await page.waitForTimeout(7000);
  const ok = await page.evaluate(() => !!window.__oneySolid);
  if (!ok) {
    console.error("No collision solver on the page (is public/bunny.collision.json there, and the GLB loading?)");
    process.exit(1);
  }

  let failed = false;
  for (const p of poses) {
    if (p !== "idle") await page.click(`button:text-is("${p}")`);
    let raw = 0;
    let res = 0;
    let where = "";
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const s = window.__oneySolid;
        return [s.raw, s.residual, s.residualWhere];
      });
      raw = Math.max(raw, m[0]);
      if (m[1] > res) [res, where] = [m[1], m[2]];
    }
    const bad = res * 100 > maxCm;
    failed ||= bad;
    console.log(`${bad ? "FAIL" : "ok  "} ${p.padEnd(10)} before solve ${(raw * 100).toFixed(1).padStart(5)} cm   after ${(res * 100).toFixed(2)} cm  ${bad ? where : ""}`);
    if (shots) await page.screenshot({ path: `${shots}-${p}.png`, timeout: 60000 });
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
