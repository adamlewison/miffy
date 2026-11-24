#!/usr/bin/env node
/**
 * Screenshot Oney on the /preview test bench (headless Chromium).
 *
 *   node tools/shots.cjs --out .oney-out/front                      # idle, front
 *   node tools/shots.cjs --out .oney-out/face --view face
 *   node tools/shots.cjs --out .oney-out/g --hold --shells 4 --wait 6000 --actions wave,sad,nuzzle
 *
 * Options
 *   --out PATH       file prefix (".png" or "-<action>.png" is appended)   [required]
 *   --view V         face | side | paw (default: front)
 *   --shells N       fur layers (default 16; use 3-6 for gestures, it renders much faster)
 *   --hold           keep gestures on (adds ?hold=1) — needed for gesture screenshots
 *   --actions LIST   comma list of /preview buttons to press, one screenshot each
 *                    (idle listening thinking talking hop ear_flick wiggle spin wave sad nuzzle)
 *   --wait MS        wait after each action (default 1600; use 6000 with --hold)
 *   --size WxH       viewport (default 600x820)
 *
 * Env: ONEY_URL (default http://localhost:3000), BUNNY_PASSCODE (to get past the lock).
 *
 * In a cloud sandbox there's no GPU: WebGL runs on SwiftShader and the fur is slow,
 * so animation only advances a few frames per second. Use --hold and a long --wait
 * (or fewer --shells) when capturing gestures, or they won't have blended in yet.
 */
const { chromium } = require("playwright");

function args() {
  const a = { view: "", shells: 16, hold: false, actions: "", wait: 1600, size: "600x820", out: "" };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, "");
    if (k === "hold") a.hold = true;
    else a[k] = v[++i];
  }
  if (!a.out) {
    console.error("usage: node tools/shots.cjs --out PATH [--view face] [--shells 16] [--hold] [--actions wave,sad] [--wait 1600]");
    process.exit(2);
  }
  return a;
}

(async () => {
  const a = args();
  const base = process.env.ONEY_URL || "http://localhost:3000";
  const [w, h] = a.size.split("x").map(Number);
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  if (process.env.BUNNY_PASSCODE) {
    const r = await ctx.request.post(`${base}/api/login`, { data: { passcode: process.env.BUNNY_PASSCODE } });
    if (!r.ok()) console.error("login failed:", r.status());
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const q = new URLSearchParams({ shells: String(a.shells) });
  if (a.view) q.set("view", a.view);
  if (a.hold) q.set("hold", "1");
  await page.goto(`${base}/preview?${q}`);
  await page.waitForTimeout(9000); // model + fur compile
  const acts = a.actions.split(",").filter(Boolean);
  if (!acts.length) {
    await page.screenshot({ path: `${a.out}.png`, timeout: 120000 });
    console.log(`${a.out}.png`);
  }
  for (const act of acts) {
    if (act !== "idle") await page.click(`button:text-is("${act}")`);
    await page.waitForTimeout(Number(a.wait));
    await page.screenshot({ path: `${a.out}-${act}.png`, timeout: 120000 });
    console.log(`${a.out}-${act}.png`);
  }
  await browser.close();
})();
