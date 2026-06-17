# FishBarrel Privacy Policy

*Last updated: 17 June 2026*

FishBarrel is a Chrome extension that helps users report misleading
advertising claims to consumer-protection regulators (Advertising Standards
Authority, ACCC, FTC, etc.). This policy explains what data the extension
touches, where it goes, and what does NOT happen with it.

## What FishBarrel stores on your device

- Your contact details (name, address, postcode, phone, email).
- Your selected country and complaint-letter templates.
- Settings for the optional on-device AI feature, including your prompt
  template if you've customised it.
- During a capture session: the text passages you highlight, the URLs they
  came from, your typed background-info notes, and the in-progress
  complaint.

All of the above is stored in your browser via `chrome.storage.local`
(settings) and `chrome.storage.session` (in-progress capture state). It
lives on your machine.

## Why the contact details are stored

The contact details exist for one purpose: when you choose to submit a
complaint to a regulator, FishBarrel opens that regulator's own complaint
form in a new tab and **fills the relevant fields in for you** — your
name, address, email, phone, plus the captured claim text and any
background notes. That is the extension's entire reason for existing:
to spare you the friction of typing the same information into the same
forms over and over.

## Where personal data goes when you submit a complaint

When you click *Submit* on the regulator's form, the data in those
fields is sent **directly to the regulator** — not to FishBarrel.
The data being transmitted at that point typically includes:

- Your name and contact details (address, postcode, phone, email)
- The captured claim text (quotes you highlighted or that the AI
  scanner identified, plus the URLs they came from)
- Any background-info notes you added
- The complaint body generated from your template
- The organisation/business you are complaining about

Once that submission leaves your browser, it is handled by the
regulator under **their** privacy policy and data-handling rules. Each
regulator publishes its own privacy notice (e.g. the ASA's privacy
notice, the ACCC's privacy notice). FishBarrel has no involvement in
or visibility into what the regulator does with the submission.

You always see the regulator's form before you submit. You can edit any
of the auto-filled fields, delete claims you don't want included, or
back out of the complaint entirely. Nothing is transmitted without
your explicit click on the regulator's *Submit* button.

## What FishBarrel does NOT do

- **We do not operate a server.** The extension never sends your data,
  your captured claims, your contact details, or anything else to us.
  FishBarrel originally had a central server; it was retired, and
  version 3.0 was rebuilt to be standalone.
- We do not use analytics, telemetry, error reporting, or third-party
  SDKs.
- We do not sell, share, transfer, or rent any data, because we never
  receive any.
- We do not transmit captured claims, contact details, or any other
  data to the regulator until you click *Submit* on the regulator's own
  form.

## The on-device AI feature

When you enable AI auto-detect in Options, FishBarrel uses Chrome's
built-in `LanguageModel` API (Gemini Nano) to scan the text of the page
you are visiting and identify likely misleading claims. The model runs
entirely inside Chrome on your device — page text is not transmitted to
Google, to us, or anywhere else.

## Optional site spider

The "Crawl entire site" feature opens same-host URLs in background tabs
so the AI can scan multiple pages in one session. It never leaves the
host you started on. No data is sent to FishBarrel or to any third party
as part of the crawl.

## Removing your data

Open the Options page and click *Clear stored settings*, or uninstall
the extension. Both remove every byte FishBarrel has stored on your
device. Complaints you have already submitted to a regulator are not
affected by this — they are now held by that regulator under their
retention policy.

## Contact

For questions about this policy or the extension, contact:
simon.a.perry@gmail.com
