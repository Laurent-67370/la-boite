// scripts/make-icons.cjs — génère les icônes PWA 192/512 (SVG → PNG via Playwright)
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('/root/node_modules/playwright');

const SIZES = [192, 512];
const OUT = path.join(__dirname, '..', 'public', 'icons');

// Habillage original : carré arrondi bleu profond #22577a + boîte verte à fente + étiquette
function svg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b4260"/>
      <stop offset="1" stop-color="#22577a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <g transform="translate(256 292)">
    <ellipse cx="0" cy="118" rx="128" ry="18" fill="#0d2033" opacity=".35"/>
    <path d="M-132 -46 h264 v150 a24 24 0 0 1 -24 24 h-216 a24 24 0 0 1 -24 -24 z" fill="#5aa97b"/>
    <path d="M-132 -46 h264 l-16 40 h-232 z" fill="#38a3a5"/>
    <rect x="-38" y="-24" width="76" height="22" rx="11" fill="#0f2a38"/>
    <g transform="translate(88 -158) rotate(8)">
      <rect x="-46" y="-58" width="92" height="116" rx="12" fill="#eef6f3"/>
      <rect x="-46" y="-58" width="92" height="30" rx="12" fill="#c7e2d4"/>
      <rect x="-28" y="-16" width="56" height="10" rx="5" fill="#38a3a5"/>
      <rect x="-28" y="4" width="34" height="10" rx="5" fill="#9bb9c6"/>
    </g>
    <g transform="translate(-96 -142) rotate(-9)">
      <rect x="-40" y="-50" width="80" height="100" rx="11" fill="#f6faf8"/>
      <rect x="-40" y="-50" width="80" height="26" rx="11" fill="#dcede2"/>
      <rect x="-24" y="-12" width="48" height="9" rx="4.5" fill="#df8a3c"/>
      <rect x="-24" y="6" width="30" height="9" rx="4.5" fill="#9bb9c6"/>
    </g>
  </g>
</svg>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const size of SIZES) {
    const html = `<!DOCTYPE html><html><body style="margin:0;width:${size}px;height:${size}px">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg(size)).toString('base64')}"
           style="display:block;width:${size}px;height:${size}px">
    </body></html>`;
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(OUT, `icon-${size}.png`), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`icône générée : public/icons/icon-${size}.png`);
  }
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });