# FishBarrel — Authority wiring audit

*Initial audit: 2026-06-18. Rewiring pass: same day. All work driven by the
in-extension automation harness (`automation.html` + the postMessage
bridge in `inject.js`). Synthetic test identity used throughout; no real
complaints were submitted.*

## Headline

**3 of 12 regulator handlers wired correctly after this pass.**

| Status | Count | Authorities |
|---|---|---|
| **WORKING** (post-2026 wiring) | 3 | ASA, NZASA, ASAI |
| **BROKEN** — out-of-date wiring, helpUrl updated to current best landing/form page | 9 | MHRA, ACCC, CRP, FDA, CanadianCompBureau, CanadianASC, SRC, VZHH, DKMA |

The 9 broken handlers all run their `markBroken` stub on click —
opens the regulator's current landing or form page in a new tab so the
user can file manually. The Review-page button shows *"(out of date)"*
with a greyed-out tint.

## What works

### ASA (UK) — already modernised in earlier 2026 work

- URL: `https://www.asa.org.uk/make-a-complaint.html`
- 37 fields, 13 filled by autofill on initial scan.

### NZASA (New Zealand) — newly rewired

- URL: `https://www.asa.co.nz/complaints/make-a-complaint/`
- Form is built on Forminator (a WordPress plugin). All fields exist in
  the DOM from page load even though the user navigates through a
  multi-step wizard — so a single fill pass survives the wizard.
- Mapping (semantic label → Forminator name):
  - First Name → `name-1-first-name`
  - Last Name → `name-1-last-name`
  - Street → `address-1-street_address`
  - Suburb → `address-1-address_line`
  - City → `address-1-city`
  - Post Code → `address-1-zip`
  - Phone → `phone-1`
  - Email → `email-1`
  - Advertiser → `text-1`
  - URL → `url-1`
  - Complaint details → `textarea-1`
- Verified: **11 of 11** candidate fields fill on first load. The
  fillFields → readFieldValues round-trip confirmed every value
  landed.

### ASAI (Ireland) — newly rewired

- URL: `https://adstandards.ie/make-a-complaint/make-a-complaint/`
  (ASAI rebranded as *Advertising Standards* on `adstandards.ie`.)
- Form is Gravity Forms. Multi-step with conditional logic; field names
  use the `input_N.M` pattern. Labels are recoverable from
  `<label for="input_1_N_M">` so the mapping is semantic.
- Mapping:
  - Consent checkbox → `input_68.1` (must be `true` for the form to
    accept submission)
  - First → `input_63.3` / Last → `input_63.6`
  - Street → `input_65.1`, City → `input_65.3`, County → `input_65.4`,
    Eircode → `input_65.5`, Country → `input_65.6`
  - Phone → `input_99`, Email → `input_100`
  - Name of advertiser → `input_14`
  - Product/Service → `input_15`
  - Website URL → `input_33`
  - Description of ad → `input_31`
  - Reason it breaches the Code → `input_58`
- Verified: **14 of 14** candidate fields fill on first load.

## What's still broken (and the verified helpUrls now point at current pages)

| Authority | Updated helpUrl | Why still broken |
|---|---|---|
| **MHRA** | <https://www.gov.uk/report-problem-medicine-medical-device> | gov.uk's report-a-problem flow generates fields per session; field names not stable across loads |
| **ACCC** | <https://www.accc.gov.au/consumers/problem-with-a-product-or-service-you-bought> | Page is an info hub, not a single form |
| **CRP** | <https://www.tga.gov.au/safety/report-problem/report-breach> | CRP dissolved; TGA flow uses a separate "Report a breach" form not yet mapped |
| **FDA** | <https://www.fda.gov/safety/report-problem-fda> | Page is a router; actual report forms are per-product-category |
| **CanadianCompBureau** | <https://competition-bureau.canada.ca/en/how-we-foster-competition/deceptive-marketing-practices/report-deceptive-marketing-practice> | Bureau moved domains; new deceptive-marketing report flow not yet mapped |
| **CanadianASC** | <https://complaints.adstandards.ca/pub/complaints?lang=en> | Actual form URL found; it's a multi-step ASP.NET WebForm gated by an initial-category radio, would need per-step wiring |
| **SRC** | <https://www.reclamecode.nl/klacht-indienen/klachtenformulier/> | Page is descriptive only — no form embedded, complaints go via mailto/phone |
| **VZHH** | <https://www.vzhh.de/> | Original Gmail-compose wiring is dead; VZHH publishes contact details rather than a form |
| **DKMA** | <https://laegemiddelstyrelsen.dk/en/contact/> | Same root cause as VZHH; DKMA also rebranded to Lægemiddelstyrelsen |

Each of these would be wireable with similar work to NZASA/ASAI, but
needs per-regulator investigation: identify the actual form URL,
inspect field structure, handle multi-step flows or category-specific
forms.

## Automation harness summary

What's now permanently in the codebase (in addition to the audit harness
from the previous pass):

- `automation.html` / `automation.js` — extension control surface with
  `window.FBControl` (open at `chrome-extension://<id>/automation.html`).
- `inject.js` `postMessage` bridge so any http(s) page can drive the
  extension via the SW.
- Generic SW message handlers (`navigateTab`, `fillFields`,
  `readFieldValues`, `clickElement`, `harvestLinks`, `openTab`,
  `closeTab`, `activateTab`, `waitTabComplete`, `snapshotForm`,
  `listAuthorities`, `setSyntheticSettings`, `restoreSettings`).
- `FishBarrel.FormRecorder.getLatestSnapshot()` for programmatic
  access to the snapshot data.
- `markBroken(authority, reason, helpUrl)` helper for marking
  authorities as needing manual filing.
- ASA-style `FillFirstMatch` candidate-list pattern that NZASA and
  ASAI now use too — degrades gracefully if a regulator renames a
  field.

## Reproducing the rewire harness

Any time a regulator's wiring breaks again:

1. Open any http(s) page; the `postMessage` bridge is loaded into
   every tab.
2. Paste the `window.fb` helper from this commit's audit harness:
   ```js
   window.fb = msg => new Promise((res, rej) => {
     const id = 'fb_' + Math.random().toString(36).slice(2);
     const t = setTimeout(() => rej(new Error('timeout')), 30000);
     window.addEventListener('message', function l(e) {
       if (!e.data || !e.data.__fishbarrel_test_response || e.data.id !== id) return;
       clearTimeout(t); window.removeEventListener('message', l); res(e.data.response);
     });
     window.postMessage({__fishbarrel_test: true, id, message: msg}, '*');
   });
   ```
3. Capture real settings, swap for synthetic:
   ```js
   const real = await fb({type:'getSettings'});
   await fb({type:'setSyntheticSettings', settings: {
     title:'Mr', firstName:'Test', surname:'Person', address:'1 Test Street',
     city:'Testchester', county:'Testshire', postcode:'TE1 1ST',
     phonenumber:'+44 7700 900000', email:'test@example.com', Country:'UK'
   }});
   ```
4. Open a victim tab, navigate, snapshot, build mappings, test fills,
   verify via `readFieldValues`. Code into `authorities.js`.
5. Restore: `await fb({type:'restoreSettings', backup: real, clearFirst: true});`

## Out of scope

- Solving CAPTCHAs / Cloudflare Turnstile / login walls (any submission
  requiring them is user-side).
- Mapping multi-step .NET WebForms (CanadianASC) — each step's
  conditional rendering needs sequential clicks + per-step snapshot.
- Mapping gov.uk's report-a-problem framework where field names vary
  per session.
- Researching what each of VZHH/DKMA expects from a non-Gmail
  alternative; their landing pages don't expose a form.
