// Builds the unpacked extension into dist/. Service workers reject `import()`, so the worker is one ESM file with no
// splitting, and the build fails on any `import(` left in it outside the reviewed modules below.
//
// Chrome loads the unpacked extension from dist/ and can start its worker at any time, also during a build. So the build
// writes a staging folder and swaps it in last: dist/ is never half written, and a failed build leaves the previous one.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const target = "dist";
const outdir = "dist.new";
const previous = "dist.old";
// `--no-run-script` builds the store fallback without Run script (for a store review that refuses Run script as remote code): its manifest leaves
// out the userScripts permission, so Chrome gives pi no chrome.userScripts, run_script is never offered, and Settings
// hides it.
const runScript = !process.argv.includes("--no-run-script");

/** Modules whose `import(` the worker never reaches, and why. A dependency update that adds one fails the build. */
const REVIEWED_IMPORTS = {
	"node_modules/@earendil-works/pi-ai/dist/auth/context.js": "default auth context; models.ts passes its own",
	"node_modules/@earendil-works/pi-ai/dist/env-api-keys.js": "Node-only environment lookup",
	"node_modules/@earendil-works/pi-ai/dist/auth/oauth/load.js":
		"OAuth loader; models.ts replaces OpenAI's sign-in and refuses other providers' OAuth credentials",
	"node_modules/openai/internal/uploads.mjs": "text of an error message, not a call",
	"node_modules/@anthropic-ai/sdk/internal/uploads.mjs": "text of an error message, not a call",
};
// package.json holds the release version; the manifest must name the same one, since Chrome and the store read it there.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifestVersion = JSON.parse(readFileSync("static/manifest.json", "utf8")).version;
if (manifestVersion !== version) {
	console.error(`static/manifest.json has version ${manifestVersion}, package.json ${version}; set both to the same.`);
	process.exit(1);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

const common = {
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome120",
	splitting: false,
	sourcemap: "linked",
	// Licence texts of the bundled packages go to THIRD_PARTY_NOTICES.txt instead (most carry no legal comments).
	legalComments: "none",
	metafile: true,
	logLevel: "warning",
};

const bundles = [
	await build({ ...common, entryPoints: { background: "src/background/main.ts" }, outdir }),
	await build({
		...common,
		entryPoints: {
			panel: "src/panel/panel.ts",
			"diagram-worker": "src/panel/diagram-worker.ts",
			diagnostics: "src/diagnostics/diagnostics.ts",
			"chatgpt-callback": "src/callback/chatgpt-callback.ts",
		},
		outdir,
	}),
];

cpSync("static", outdir, { recursive: true });
if (!runScript) {
	const manifest = JSON.parse(readFileSync(`${outdir}/manifest.json`, "utf8"));
	manifest.permissions = manifest.permissions.filter((permission) => permission !== "userScripts");
	writeFileSync(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, "\t")}\n`);
}

/** A package.json `repository` as a web URL: "git+https://github.com/a/b.git" and "github:a/b" -> https://github.com/a/b. */
function sourceUrl(repository) {
	const url = typeof repository === "string" ? repository : repository?.url;
	if (url === undefined) return undefined;
	const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
	if (shorthand) return `https://github.com/${shorthand[1]}`;
	return url
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^ssh:\/\/git@/, "https://")
		.replace(/\.git$/, "");
}

// Every package with code in a bundle, with its licence text.
const packages = new Set();
for (const { metafile } of bundles) {
	for (const input of Object.keys(metafile.inputs)) {
		const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
		if (match) packages.add(match[1]);
	}
}
const notices = [...packages].sort().map((dir) => {
	const { name, version, license, repository, homepage } = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
	// Where its source is, as some licences (EPL-2.0) ask of a build that bundles them, and useful for the others.
	const url = sourceUrl(repository) ?? homepage;
	const source = url === undefined ? "" : `\nSource: ${url}`;
	const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
	if (file !== undefined)
		return `${name}@${version}${license ? ` (${license})` : ""}${source}\n\n${readFileSync(`${dir}/${file}`, "utf8").trim()}\n`;
	if (license === undefined) throw new Error(`${name} has neither a licence file nor a licence field`);
	return `${name}@${version} (${license}; the published package has no licence text)${source}\n`;
});
writeFileSync(`${outdir}/THIRD_PARTY_NOTICES.txt`, notices.join(`\n${"-".repeat(80)}\n\n`));

const worker = readFileSync(`${outdir}/background.js`, "utf8");
console.log(
	`built ${target}/${runScript ? "" : " without Run script"}: background.js ${Math.round(worker.length / 1024)} KiB; notices for ${packages.size} package(s)`,
);
let unreviewed = 0;
for (const match of worker.matchAll(/\bimport\s*\(/g)) {
	const before = worker.slice(0, match.index);
	// esbuild starts each bundled module with a `// <path>` comment.
	const module = [...before.matchAll(/^\/\/ ((?:node_modules|src)\/\S+)$/gm)].at(-1)?.[1] ?? "(unknown module)";
	const reason = REVIEWED_IMPORTS[module];
	if (reason === undefined) unreviewed += 1;
	console.log(`  import( in ${module}: ${reason ?? "NOT REVIEWED"}`);
}
if (unreviewed > 0) {
	console.error(`background.js has ${unreviewed} unreviewed import( site(s); service workers reject import().`);
	process.exit(1);
}

// Two renames: dist/ is missing only between them, for no file read to notice.
rmSync(previous, { recursive: true, force: true });
if (existsSync(target)) renameSync(target, previous);
renameSync(outdir, target);
rmSync(previous, { recursive: true, force: true });
