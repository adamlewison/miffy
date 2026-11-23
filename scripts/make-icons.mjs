// Renders scripts/bunny-face.svg into the PWA icons. Run: npm run icons
// Uses the Playwright that's installed globally (or `npm i -D playwright`).
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const svg = readFileSync(new URL("./bunny-face.svg", import.meta.url), "utf8");
const out = new URL("../public/icons/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const targets = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, false],
  ["avatar.png", 400, false],
  ["favicon-32.png", 32, false],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, maskable] of targets) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons need the art inside the central 80% safe zone.
  const inner = maskable ? `<div style="width:100%;height:100%;background:#e9cfb4;display:grid;place-items:center"><div style="width:80%;height:80%">${svg}</div></div>` : svg;
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${inner}<style>svg{width:100%;height:100%;display:block}</style></body></html>`);
  await page.screenshot({ path: out + name, omitBackground: false });
  console.log("wrote", name);
}
await browser.close();
