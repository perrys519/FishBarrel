# FishBarrel Privacy Policy

*Last updated: 17 June 2026*

FishBarrel is a Chrome extension that helps users report misleading
advertising claims to consumer-protection regulators (Advertising Standards
Authority, ACCC, FTC, etc.). This policy explains what data the extension
touches and what happens to it.

## What FishBarrel stores on your device

- Your contact details (name, address, postcode, phone, email) that you
  enter on the Options page, so the extension can auto-fill the regulator's
  complaint form.
- Your selected country and complaint-letter templates.
- Settings for the optional on-device AI feature.
- During a capture session: the text passages you highlight, the URLs they
  came from, your typed background-info notes, and the in-progress complaint.

All of the above is stored in your browser via `chrome.storage.local`
(settings) and `chrome.storage.session` (in-progress capture state). It
stays on your machine.

## What FishBarrel does NOT do

- We do not operate a server. The extension never sends your data, your
  captured claims, your contact details, or anything else to us.
  FishBarrel originally had a central server; it was retired, and
  version 3.0 was rebuilt to be standalone.
- We do not use analytics, telemetry, error reporting, or third-party
  SDKs.
- We do not sell, share, transfer, or rent any data, because we never
  receive any.

## The on-device AI feature

When the user enables AI auto-detect in Options, FishBarrel uses Chrome's
built-in `LanguageModel` API (Gemini Nano) to scan the text of the page
the user is visiting and identify likely misleading claims. The model
runs entirely inside Chrome on the user's device — page text is not
transmitted to Google, to us, or anywhere else.

## Submitting a complaint

When the user clicks the button for a specific regulator on the Review
page, the extension opens that regulator's own complaint form in a new
tab and pre-fills the fields. The user reviews the form and submits it
directly to the regulator. Once the user clicks submit on the regulator's
site, the data goes to that regulator under their own privacy terms —
FishBarrel is not involved in the submission and does not see what was
sent.

## Optional site spider

The "Crawl entire site" feature opens same-host URLs in background tabs
to let the AI scan multiple pages in one session. It never leaves the
host the user started on. No data leaves the device.

## Removing your data

Open the Options page and click *Clear stored settings*, or uninstall
the extension. Both remove every byte FishBarrel has stored.

## Contact

For questions about this policy or the extension, contact:
simon.a.perry@gmail.com
