# Privacy policy

pi-aside is a Chrome extension that sends your questions, and the parts of web pages you choose, to an AI provider
that you set up. This policy says what it handles, where that goes, and how to delete it.

Last updated: 2026-10-30.

## In short

- pi-aside has no server. Its developer receives none of your data: no messages, pages, keys, usage, or analytics.
- What you ask goes from your browser straight to the AI provider you chose, with your own key or sign-in.
- Everything pi-aside keeps stays in your Chrome profile, until you delete it or remove the extension.

## What goes to your AI provider

pi-aside works with OpenRouter, OpenAI, Anthropic, and DeepSeek. When you send a message, pi-aside sends the request to
the provider of the model you picked, and to no one else. Depending on what you ask and which tools you allow
(Settings > Tools), a request can contain:

- your messages, and the text you selected;
- the images and text files you attach to a message;
- the title and address of the attached page, and, if the tab has left it when you send, the title and address of the
  page the tab shows, or the site pi-aside last saw the tab sent to;
- the text pi-aside reads from the page, and the list of its links, buttons, fields, and headings;
- screenshots of the tab;
- the scripts pi-aside writes, and what they return;
- the titles and addresses of the tabs in the attached tab's Chrome group;
- earlier messages and results in the same chat, so the model has the conversation.

When pi-aside reads or observes a page, it leaves out what is typed in form fields, and it never reads text selected
in a password field. A screenshot shows what the tab shows, and a script you allow can read anything on the page.

The provider handles this under its own privacy policy and terms. With OpenAI's web search turned on (Settings >
Providers > OpenAI), OpenAI may search the web for a request.

## Keys and sign-in

- API keys are sent only to the provider they belong to, to verify them and to send requests.
- With Sign in with ChatGPT, the sign-in tokens are sent only to OpenAI. pi-aside also keeps the account's email
  address, to show which account is signed in. Signing out asks OpenAI to end the sign-in.
- Keys and tokens are stored unencrypted in the Chrome profile (`chrome.storage.local`). Web pages and other
  extensions cannot read them; programs running as you, or anyone with your profile's files, can.

## What pi-aside stores on your computer

- **Chats**, in the extension's own database: your messages and what you attached to them, the answers, and what
  pi-aside read or did on pages (page text, screenshots, scripts and their results), until you delete all chats.
- **Settings and prompts**, in `chrome.storage.local`.
- **Unsent messages** and which chat each tab shows, in `chrome.storage.session`, until the browser closes or the
  extension reloads.
- **A diagnostics log** of the extension's own events and errors, without keys, shown on its Diagnostics page.

None of this leaves your computer, except as part of a request to your AI provider described above.

## Scripts on pages

With Run script allowed, pi-aside can run a script that the model writes on a page you are visiting. It runs as you,
with your login on that site, so it could change things there or send page data to other sites. pi-aside shows each
script and asks before running it, unless you choose to let the next ones run for the rest of an answer or chat, or
set Run script to On. Run script also needs Chrome's "Allow User Scripts" switch for pi-aside, which is off by default.

## Access to pages

pi-aside reads a tab only after you click its toolbar button, use its right-click menu, or press one of its shortcuts
there, or on sites you allowed with "Always allow" or "Allow all sites". Settings > Advanced > Sites lists them and removes them.
On a page it may read, pi-aside notes which site a link, a form, or the page itself sends the tab to next, so that if
it then needs access there, it can ask for that site by name. It keeps only the site's name, in memory, until the tab
moves on to a page pi-aside may read or closes. A message you send about a page the tab has left tells your AI
provider that site, as above.

## Deleting your data

- **All chats:** Settings > Advanced > Data > Delete all chats. Settings, keys, and the sign-in stay.
- **One chat:** pi-aside cannot yet delete a single chat. Remove from History (History, then the chat's ⋯ menu)
  hides it, but its data stays stored until you delete all chats.
- **A key or the ChatGPT sign-in:** Settings > Providers.
- **Everything:** remove the extension at `chrome://extensions`. Chrome deletes all of its stored data.

What a provider received is kept under that provider's policy; deleting it in pi-aside does not delete it there.

## What pi-aside does not do

pi-aside does not sell your data, use it for advertising, or transfer it for any purpose other than answering your
requests. It does not use your data to decide creditworthiness or for lending. Its use of data follows the Chrome Web
Store User Data Policy, including the Limited Use requirements.

## Changes and contact

Changes to this policy are made in this file, with a new date at the top. Questions:
[open an issue](https://github.com/yzhg1983/pi-aside/issues).
