// sight-stamp.mjs — the Playwright stamper sight-check.sh uses when ImageMagick
// is not installed, so the sight gate runs on a stock Mac or Linux box.
//
// Same output as the ImageMagick path: a 56px strip reading
// "QA SIGHT CODE  <code>" appended BELOW the shot (every y-coordinate in the
// page is unchanged), written to <png>.stamped for the caller to move into
// place. The strip is then measured: a strip that rendered blank (no font) is a
// code nobody can read, and exits 4 rather than producing an unpassable gate.
//
// Argv: <node_modules parent dir> <png> <code>
// Exit: 0 stamped · 4 the strip rendered blank · 1 anything else failed
//
// peers:
//   .agents/skills/qa/scripts/sight-check.sh
//   .agents/skills/qa/scripts/tests/sight-check-playwright.test.sh

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const [pwParent, png, code] = process.argv.slice(2);
const { chromium } = createRequire(`${pwParent}/`)("playwright");

const buf = readFileSync(png);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
const STRIP = 56;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: w, height: h + STRIP }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;background:#fff">` +
      `<img style="display:block;width:${w}px;height:${h}px" src="data:image/png;base64,${buf.toString("base64")}">` +
      `<div id="strip" style="height:${STRIP}px;background:#101010;color:#f5f5f5;` +
      `font:${Math.min(30, Math.floor(w / 14))}px/${STRIP}px monospace;text-align:center;white-space:nowrap">QA SIGHT CODE&nbsp;&nbsp;${code}</div></body>`,
    { waitUntil: "load" },
  );
  await page.screenshot({ path: `${png}.stamped`, type: "png", clip: { x: 0, y: 0, width: w, height: h + STRIP } });

  // Ink in the strip: the share of pixels that are not its background colour.
  const strip = (await page.locator("#strip").screenshot()).toString("base64");
  const ink = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = "data:image/png;base64," + data;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 0x40 || px[i + 1] > 0x40 || px[i + 2] > 0x40) lit++;
    return lit / (px.length / 4);
  }, strip);
  if (!(ink > 0.005)) process.exit(4);
} finally {
  await browser.close();
}
