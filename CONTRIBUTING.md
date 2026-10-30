# Contributing to pi-aside

How to set up, check, and test pi-aside.

## Setup

You need Node.js 22.19 or later with npm, and Chrome 140 or later.

```sh
npm ci --ignore-scripts   # dependencies, without install scripts
npm run build             # writes dist/
```

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose `dist/`. After a change, run
`npm run build` again and press the reload icon on pi-aside's card.

## Before you push

```sh
npm run check   # Biome (writes its fixes) and tsc
npm test        # unit tests, in Node
npm run build   # also fails on an unreviewed import( and on a package without a licence
```

Then run the browser suite for the part you changed. CI runs all of them on pull requests and on `main` (CI and releases).

## Browser test suites

Each suite builds a throwaway copy of the extension and tests it in Chrome for Testing, with a fresh profile, local
pages, and a fake model provider: no accounts, keys, or network. Get Chrome for Testing with
`npx @puppeteer/browsers install chrome@153`, then run a suite with `CHROME=/path/to/chrome npm run test:<suite>`.

| Suite | Run it after changing |
| --- | --- |
| `storage` | storage, `session.ts` |
| `wake` | keepalive and recovery (`active-work.ts`, `breaker.ts`) |
| `selection` | reading a page or a selection, New chat, web search |
| `page-tools` | observe, act, run_script, wait_on_page |
| `screenshots` | screenshot_page (Chrome 147+) |
| `slash` | prompts, slash commands |
| `edit` | the chat UI: Copy, Edit, Stop, removing the tab's chat |
| `attachments` | images and text files in the message box (`attach.ts`, `attachments.ts`) |
| `diagrams` | diagrams, pele |
| `localization` | any interface text (Chrome 147+) |

`page-tools` and `screenshots` use the same port: run them one at a time.

## Tests and code

- Unit tests are in `test/`, most named after the module they test; they use Node's SQLite for storage, so storage itself
  is tested in Chrome by the `storage` suite. Shared helpers are in `test/fixtures/`.
- `src/background/` is the extension's worker, `src/panel/` the side panel, `src/shared/` code both use, and
  `static/` the manifest, pages, and interface text in both languages.

Rules that keep the extension correct:

| Change | Where | Rule to keep |
| --- | --- | --- |
| New Chrome event | `main.ts`, module scope | Register synchronously. Call `sidePanel.setOptions()` and `open()` for the tab before any `await`. Get the Harness through `session()` or `wake()`. |
| Work-starting mutation | `chats.ts`, `session.ts`, inside `activeWork.admit()` | Arm recovery before submit, abort/abortTask (including the breaker), or a runtime registry change. If arming fails, do not execute the mutation. Check the model before submitting. |
| Code at worker start | `open()` in `session.ts`, before `resume()` | Stop a run with `abortTask()` before `resume()`, never after; withdraw its queued inputs first. A failure must close the Harness. |
| Storage lifecycle | `session.ts` | Hold the Web Lock from before open until `harness.closed`; close failed initialization. |
| New panel command | `protocol.ts` and `run()` in `main.ts` | Never return or log a key. A chat command carries the tab's `rev` the page saw. A change of message shapes bumps `PROTOCOL_VERSION`. |
| Interface text | Both `static/_locales/` catalogs | Keep keys and placeholders in sync; never store a translated prompt name. |
| New provider | `models.ts`, manifest `optional_host_permissions` | Keys go only to the provider's fixed address, and only with its host permission. |
| New dependency | `package.json` | A new `import(` fails the build until it is reviewed; a package without a licence fails it too. |
| pi-durable or pi-ai API | any | Check the 1.4.0 types in `node_modules`, not the pi-mono source. |
| Commit callback | any `commit()` | Await nothing outside `tx` (a Chrome call, a timer): every chat's commits, streaming included, run on one line. Make native calls before or after the commit, as `switch_tab` does. |
| Icon or screenshots | `assets/`, `scripts/` | `CHROME=… npm run icons` or `npm run screenshots`, then commit what they write. The screenshots load live sites: check them before committing. In them the model's turns are scripted and the page tools run for real: they show the interface, not a model's accuracy or speed. |

## CI and releases

CI (`.github/workflows/ci.yml`) runs on pushes to `main`, pull requests, weekly, and from the Actions tab, in one job:
the checks, unit tests, and build, then every browser suite on the Chrome version in `CHROME_VERSION`. A push or pull
request runs the browser suites only when it changes `src/`, `static/`, `test/e2e/`, the build, or the dependencies, and
a change to only Markdown or `docs/` runs nothing. A push to another branch runs nothing: open a pull
request or run CI from the Actions tab.

To release: set the same, higher version in `package.json` and `static/manifest.json` and commit it to `main`, then
push a tag for it (`git tag v0.1.0 && git push origin v0.1.0`). The release workflow checks and builds it and drafts a
GitHub Release with `pi-aside-<version>.zip`; check and publish the draft, then upload the zip to the Chrome Web Store.
The draft also holds `pi-aside-<version>-no-run-script.zip` (`npm run build -- --no-run-script`): the same build without
the `userScripts` permission and Run script, to upload instead if the store's review refuses Run script.
A change to the manifest's permissions or to the data pi-aside handles also changes the store's Privacy practices tab,
which the maintainer updates.
