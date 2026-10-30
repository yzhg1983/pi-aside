// Renders the extension's icons from assets/*.svg into static/icons/: 16 and 32 px from size-specific drawings,
// 48 px from the large drawing without its padding, and 128 px with the padding the Chrome Web Store asks for.
// Run after changing an icon: CHROME="/path/to/chrome-for-testing" npm run icons

import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome or Chrome for Testing executable.");

const large = readFileSync("assets/icon.svg", "utf8");
const icons = [
	{ size: 16, svg: readFileSync("assets/icon-16.svg", "utf8") },
	{ size: 32, svg: readFileSync("assets/icon-32.svg", "utf8") },
	// The artwork spans 16..112 x 20..108: a 48 px icon shows it with a thin margin instead of the store's padding.
	{ size: 48, svg: large.replace('viewBox="0 0 128 128"', 'viewBox="12 12 104 104"') },
	{ size: 128, svg: large },
];

mkdirSync("static/icons", { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
	for (const { size, svg } of icons) {
		const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
		const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
		await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
		await page.locator("svg").screenshot({ path: `static/icons/icon-${size}.png`, omitBackground: true });
		await page.close();
		console.log(`static/icons/icon-${size}.png`);
	}
} finally {
	await browser.close();
}
