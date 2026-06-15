# OpenAgenticOS Call Cockpit — Chrome side panel

A **side panel** that opens next to your dialer or sheet and shows, for whoever you're dialing:
the account brief, contacts ranked by fit, the call angle / trigger / objection
notes, memory from your optional local brain folder (positioning, proof, old notes, closed-lost),
one-click **Open LinkedIn**, and **outcome logging** back to the account.

It reads from the OpenAgenticOS cockpit API. Your dialer handles live calling;
this panel decides who to call next and puts the context in front of you.

## Load it (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this `extension/` folder.
2. Right-click the extension icon → **Options** (or click ⚙ in the panel) and set the **API base URL**:
   - Local dev: `http://localhost:4100`
   - Remote/local-network hub: use your HTTPS URL.

   Plain HTTP URLs can be blocked from HTTPS pages as mixed content, so use HTTPS when the panel is opened beside a hosted web app.
3. **Click the toolbar icon** on your dialer, sheet, CRM, or sequencing tab to open the side panel.
   (Chrome only lets a side panel open from a click — it can't auto-pop, so click it once
   when you sit down to dial.)

## How it works

- A content script on `docs.google.com/spreadsheets/*`, `app.apollo.io/*`, and supported dialer pages
  detects the **phone number being dialed** (`tel:` links / dialer overlay) and relays
  it to the panel. If it can't read the dialer (e.g. canvas-rendered Sheets), type a phone or
  name in the panel's search box, or select a phone number on the page.
- Matching falls back phone → email → linkedin → name against the command center's contacts.
- Click any contact in "Contacts ranked by fit" to switch the cockpit to that person.
- **Log outcome** writes a call_log row back to the account and advances the queue row
  (connected / meeting → done, voicemail / no-answer → dialed, etc.).

## Notes

- Cockpit endpoints are read-only GETs (plus the outcome POST) and the server returns
  `Access-Control-Allow-Origin: *` for `/api/cockpit/*` so the panel can fetch cross-origin.
- Auto-open LinkedIn is off by default (best for parallel dialing); toggle it in Options.
- No extension? `<API base>/cockpit?phone=…` is the same cockpit as a normal browser tab.
