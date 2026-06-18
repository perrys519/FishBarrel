# FishBarrel — Authority wiring audit

*Audit run: 2026-06-18, against the live regulator websites via the new
in-extension automation harness (`automation.html` + the `postMessage`
bridge in `inject.js`). Synthetic test identity used throughout; no real
complaints were submitted.*

## Headline

**1 of 12 regulator handlers still wired correctly.** All others have
been marked `broken: true` and will now open the regulator's contact /
complaints landing page in a new tab when their button is clicked. The
Review page renders broken buttons with an *(out of date)* suffix and a
greyed-out style.

| Status | Count | Authorities |
|---|---|---|
| **WORKING** | 1 | ASA |
| **BROKEN** — page exists, form has been removed | 7 | MHRA, ACCC, CRP, FDA, CanadianCompBureau, NZASA, SRC |
| **BROKEN** — site moved, original URL dead/redirected | 2 | CanadianASC, ASAI |
| **BROKEN** — relied on Gmail basic-HTML compose (retired by Google 2024) | 2 | VZHH, DKMA |

## Per-authority detail

### ASA (UK) — WORKING

- Final URL: `https://www.asa.org.uk/make-a-complaint.html`
- 37 fields across 2 forms, **13 filled** by autofill on first load.
- Status pill: `FORM_LOADED`.
- The 2026 rewrite (commits `2483dfb` → `d0f19e5` → `255e132`) is doing
  its job. No change needed.

### MHRA (UK) — BROKEN, form removed

- Final URL: `https://www.mhra.gov.uk/Howweregulate/Medicines/Advertisingofmedicines/Advertisinginvestigations/Advertisingcomplaintform/index.htm`
- Page returned HTTP 200 but contains **0 fields, 0 buttons**.
- MHRA's complaint flow has moved off the dedicated path; the catch-all
  is now gov.uk's *"report a problem with a medicine or medical
  device"* page.
- Help URL: <https://www.gov.uk/report-problem-medicine-medical-device>

### ACCC (Australia) — BROKEN, redirected

- Final URL: `www.accc.gov.au/…` (full URL redacted by automation
  output filter)
- Original deep link redirects to a search/contact page; only 3 fields
  (a site-search box and a *Was this page useful?* widget).
- Help URL: <https://www.accc.gov.au/consumers/problem-with-a-product-or-service>

### CRP (Australia) — BROKEN, body dissolved

- Final URL: `https://www.tgacrp.com.au/index.cfm?pageID=12`
- Page returns HTML but has 0 form fields. The CRP itself was
  dissolved years ago; advertising complaints in Australia now go via
  the TGA's Advertising Hub.
- Help URL: <https://www.tga.gov.au/safety/complaints/lodging-advertising-complaint>

### FDA (USA) — BROKEN, form replaced

- Final URL: `https://www.accessdata.fda.gov/scripts/email/oc/buyonline/buyonlineform.cfm`
- Old "buy-online" complaint form now hosts only a search box (2
  fields, *Submit search* button). The original form is gone.
- Help URL: <https://www.fda.gov/safety/report-problem-fda>

### CanadianCompBureau (Canada) — BROKEN, form removed

- Final URL: `https://competitionbureau.gc.ca/eic/site/cb-bc.nsf/frm-eng/GHET-7TDNA5`
- Note hostname moved from `www.competitionbureau.gc.ca` to
  `competitionbureau.gc.ca`. Page returned has 0 fields, 0 buttons.
- Help URL: <https://competitionbureau.gc.ca/eic/site/cb-bc.nsf/eng/04604.html>

### CanadianASC (Canada) — BROKEN, domain moved

- Final URL: `https://adstandards.ca/eComplaints/#en` (moved from
  `adstandards.com`).
- 2 fields on the page, both unrelated to complaints (search dropdown,
  *OPEN SEARCH BAR* button). The eComplaints form was rebuilt under a
  different URL.
- Help URL: <https://adstandards.ca/complaints/submit-a-complaint/>

### NZASA (New Zealand) — BROKEN, form removed

- Final URL: `http://www.asa.co.nz/complaint_form.php`
- Page returns content but with 0 form fields. The complaints flow has
  moved to a different URL on the same site.
- Help URL: <https://www.asa.co.nz/complaints/make-a-complaint/>

### ASAI (Ireland) — BROKEN, rebranded

- Final URL: `https://adstandards.ie/complain.asp` (redirected from
  `www.asai.ie`)
- 10 total fields but only 2 visible, and those are a site search + a
  newsletter signup email. The body rebranded to *Advertising
  Standards* on `adstandards.ie` and the old `complain.asp` form is
  gone.
- Help URL: <https://adstandards.ie/make-a-complaint/>

### SRC (Netherlands) — BROKEN, form removed

- Final URL: `https://www.reclamecode.nl/consument/default.asp?paginaID=73`
- Page returns content but has 0 fields and 0 buttons. Complaint flow
  moved elsewhere on the site.
- Help URL: <https://www.reclamecode.nl/consumenten/klacht-indienen/>

### VZHH (Germany) — BROKEN, upstream service retired

- Original wiring used Gmail's basic-HTML compose URL pattern
  (`https://mail.google.com/mail/h/?v=b&cs=wh&f=1&to=…`). Google
  discontinued the basic-HTML view in 2024, so the URL no longer
  opens a compose window.
- Help URL: <https://www.vzhh.de/themen/markt-recht>

### DKMA (Denmark) — BROKEN, upstream service retired

- Same root cause as VZHH — relied on Gmail basic-HTML compose.
- The Danish Medicines Agency also rebranded to *Lægemiddelstyrelsen*
  in the intervening years and uses a web form rather than email
  intake.
- Help URL: <https://laegemiddelstyrelsen.dk/en/contact/>

## What now lives in the code

- `markBroken(authority, reason, helpUrl)` helper in
  `authorities.js` (lines ~28–41 area). Replaces the authority's
  `ComposeComplaint` with a stub that just opens `helpUrl` in a new
  tab, and sets `broken: true` + `brokenReason` so the Review page can
  reflect the state.
- An end-of-file block of 11 `markBroken(...)` calls covering every
  authority above.
- `reviewComplaint.js` renders broken buttons with an *(out of date)*
  suffix and an opacity-0.6 background tint. Clicking shows an alert
  with `brokenReason` then dispatches `composeComplaint` so the stub
  opens the help URL.
- ASA's existing wiring is unchanged.

## Re-running the audit

The harness is reproducible:

1. Reload the extension in `chrome://extensions/` so the latest
   `automation.html` / `automation.js` / `inject.js` are loaded.
2. Open any http(s) page (the harness uses the content-script bridge).
3. Paste the `window.fb` helper + `auditAuthority` setup from this
   commit's `automation.js`. Call `auditAuthority("ASA")` etc.
4. `auditAuthority` swaps your real `chrome.storage.local` for a
   synthetic identity (Test Person, 1 Test Street, etc.) and writes it
   back at end. The page-side automation console (`chrome-extension://<id>/automation.html`)
   has a manual *Restore real settings* button as a safety net.

## Out of scope from this audit

- **Researching where each regulator's complaint flow actually lives
  now.** The `helpUrl` values above are best-guess landing pages; some
  may themselves be out of date. A follow-up could click through each
  and find the live form, then rebuild that authority's
  `ComposeComplaint`/`AutoFillForm` against the new endpoint.
- **Bypassing CAPTCHA / Cloudflare Turnstile** on regulator pages. The
  audit only fills and snapshots; CAPTCHAs are user-side.
- **Adding new regulators** (e.g. a TGA Australia handler to replace
  the dissolved CRP).
- **Republishing to the Chrome Web Store.** That's a separate manual
  step once the wiring is in a state you're happy with.
