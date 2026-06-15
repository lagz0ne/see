# llms.txt eval — task rubric

Goal: measure whether a cold agent, given **only** the rendered `/llms.txt` plus a live
share, can drive the app. Shorter docs are better **as long as every task still passes** —
so each run also reports which doc lines were never needed.

## Setup (the harness does this)

`evals/llms-txt/boot.sh` boots a fresh server, seeds the `fixture/` bundle, and prints
`{ baseUrl, id, password }`. The bundle has shared tweaks `primaryColor` (`--color-primary`)
and `fontSize` (`--font-size-base`), two pages (`index.html`, `pricing.html`), a
`theme.css` stylesheet linked from `index.html` (with a `.cta` rule), and no
per-page overrides yet.

## Rules for the eval agent

- Black box. Use **only** HTTP (curl) against `baseUrl` and the text of `GET /llms.txt`.
- **Never** read this repo's source/tests/this file. Doing so invalidates the run.
- Auth edits with `Authorization: Bearer <password>`.
- Verify every change by fetching the **rendered** result, not just the API's 200.

## Tasks

1. List the share's files and read `see.json`.
2. Change the **shared** primary color to `#112233`. Verify the served homepage's injected
   `<style>` shows `--color-primary: #112233`.
3. Make **only** `pricing.html` use primary `#0A84FF`, leaving the homepage at `#112233`.
   Verify: homepage still `#112233`, pricing renders `#0A84FF`.
4. Add a **page-only** knob that shows the sale badge on `pricing.html` only
   (`--badge-display: inline`). Verify pricing injects it and the homepage does not.
5. Change the homepage `<h1>` text to `Welcome to Acme Pro`. Verify the rendered HTML.
6. Edit the stylesheet `theme.css`: change the `.cta` rule's `color` to `#0A84FF` (a real
   CSS-file edit, not a tweak). Verify the served `theme.css` now declares `color: #0A84FF`.
7. Claim the friendly name `acme-store`; confirm the new id resolves and the old one 404s.

## Scorecard the agent returns (JSON)

```
{
  "tasks": [{ "n": 1, "pass": true, "request": "<curl used>", "note": "<friction, if any>" }, ...],
  "docFriction": ["<places the doc was ambiguous / missing / misleading>"],
  "unusedDocSections": ["<headings or topics you never needed to read>"],
  "shorterVerdict": "<could the doc be ~30% shorter and still pass? which lines to cut?>"
}
```
