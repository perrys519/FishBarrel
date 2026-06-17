// FishBarrel on-device scanner. Uses Chrome's built-in LanguageModel API
// (Gemini Nano) to identify quotes on the page that look like misleading
// health claims under the user's selected regulator.
//
// Loaded as a content script before inject.js so FishBarrelAI is on the
// global before FishBarrel.Init() needs to call it.
//
// The API is documented at https://developer.chrome.com/docs/ai/prompt-api
// and is stable for extensions since Chrome 138. No manifest permission
// required. The model runs entirely on-device — page text never leaves
// the user's machine.

var FishBarrelAI = (function () {
    var DEFAULT_PROMPT_TEMPLATE = [
        'You are a strict compliance auditor. Two tasks on the "Source Text" below.',
        '',
        'TASK A — Identify the practitioner, business, clinic or organisation this page belongs to. Look at headings, the page title, contact details and signatures. Return the name as `organisation_name`. If you genuinely cannot tell, return an empty string. Examples: "Dr Victoria Karney", "Sheffield Homeopathy", "Quantum Holistic Healing Ltd".',
        '',
        'TASK B — Find violations of {REGULATOR}: quotes that claim a health, medical or psychological treatment is effective for a specific condition without robust scientific evidence. Examples of WHAT TO FLAG:',
        '  - "Homeopathy can cure your arthritis."',
        '  - "Helped my child with severe anger problems."',
        '  - "This treatment rebalances the body and restores health."',
        '  - Testimonials describing successful treatment of a named condition.',
        '',
        'DO NOT flag any of the following — set is_substantive_claim to false for them:',
        '  - Biographical info, qualifications, degrees, memberships, years of experience',
        '  - Descriptions of services or logistics ("I see patients at home", "telephone consultations available")',
        '  - Contact details, addresses, opening hours, names',
        '  - Factual statements about data handling, privacy, fees, GDPR',
        '  - Disclaimers',
        '  - Generic descriptions of what a therapy involves without claiming it works',
        '',
        'For each candidate quote, populate the JSON object with:',
        '  - quote: exact word-for-word substring of the Source Text',
        '  - reason: one sentence on why it violates {REGULATOR}',
        '  - is_substantive_claim: true ONLY if the quote actually asserts efficacy for a condition; false for anything in the "DO NOT flag" list',
        '',
        'CRITICAL RULES:',
        '1. Every "quote" MUST be an exact, word-for-word string match from the Source Text. Do NOT paraphrase or invent.',
        '2. If a candidate quote is in the "DO NOT flag" list, OMIT it entirely. Do not include it with is_substantive_claim: false unless you are uncertain.',
        '3. If no clear efficacy claims are found, return: {"violations": []}',
        '',
        'Source Text:',
        '"""',
        '{SOURCE_TEXT}',
        '"""'
    ].join('\n');

    var VIOLATIONS_SCHEMA = {
        type: "object",
        properties: {
            organisation_name: { type: "string" },
            violations: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        quote: { type: "string" },
                        reason: { type: "string" },
                        is_substantive_claim: { type: "boolean" }
                    },
                    required: ["quote", "reason", "is_substantive_claim"]
                }
            }
        },
        required: ["organisation_name", "violations"]
    };

    // Belt-and-braces filter on the model's reason text. When Nano can't find
    // a real violation it tends to fill the JSON anyway and admit in the
    // reason that the quote isn't actually a claim. These phrases catch the
    // most common admissions.
    var NEGATIVE_REASON_PATTERNS = [
        /\bnot (?:a|an|directly a) claim\b/i,
        /\bnot (?:directly )?(?:a )?(?:claim of )?efficacy\b/i,
        /\bfactual (?:statement|description|information)\b/i,
        /\bbiographical\b/i,
        /\bqualifications?\b/i,
        /\bnot (?:a )?violation\b/i,
        /\bappointment logistics\b/i,
        /\bcontact (?:details?|information)\b/i,
        /\b(?:GDPR|data privacy)\b/i,
        /\b(?:does not|doesn['’]t) (?:directly )?(?:claim|assert|imply)\b/i,
        /\bcould be interpreted\b/i,
        /\bpotentially (?:misleading|imply)\b/i
    ];

    function reasonLooksLikeSelfAdmission(reason) {
        if (!reason) return false;
        for (var i = 0; i < NEGATIVE_REASON_PATTERNS.length; i++) {
            if (NEGATIVE_REASON_PATTERNS[i].test(reason)) return true;
        }
        return false;
    }

    // Per-chunk character budget. Nano's session contextWindow is around
    // 9216 tokens on current Chrome; ~4.5 chars/token in English means a
    // prompt of ~7-8 KB sits comfortably inside it (the template adds another
    // 2 KB / ~500 tokens). Keeping chunks bigger means fewer prompts and
    // testimonials don't end up split across a chunk boundary.
    var TARGET_CHARS_PER_CHUNK = 6000;
    var MIN_CHARS_PER_CHUNK = 400;
    var MAX_CHUNKS_PER_PAGE = 5;

    // Lower-than-default temperature for more deterministic compliance scans.
    // Default (~1.0) makes Nano stochastic — same input, different answers —
    // which manifested as testimonials being flagged on one scan and missed
    // on the next. 0.3 keeps it focused without freezing it.
    var SESSION_TEMPERATURE = 0.3;
    var SESSION_TOP_K = 3;

    function regulatorForCountry(country) {
        if (!country || typeof Authorities === "undefined") {
            return "advertising standards rules on substantiation of health claims";
        }
        var names = [];
        for (var key in Authorities) {
            if (Authorities[key].Country === country && Authorities[key].Name) {
                names.push(Authorities[key].Name);
            }
        }
        if (names.length === 0) {
            return "advertising standards rules on substantiation of health claims";
        }
        return names.join(" / ");
    }

    function buildPrompt(template, regulator, sourceText) {
        return (template || DEFAULT_PROMPT_TEMPLATE)
            .replace(/\{REGULATOR\}/g, regulator)
            .replace(/\{SOURCE_TEXT\}/g, sourceText);
    }

    // Split the page text into chunks that should fit Nano's per-prompt cap.
    // Prefer paragraph boundaries; fall back to sentence boundaries inside
    // any paragraph that's still too big; hard-split as a last resort.
    function chunkText(text) {
        var paragraphs = text.split(/\n\s*\n+/);
        var chunks = [];
        var current = "";

        function flush() {
            var t = current.trim();
            if (t.length > 0) chunks.push(t);
            current = "";
        }

        for (var i = 0; i < paragraphs.length; i++) {
            var p = paragraphs[i].trim();
            if (!p) continue;

            if (p.length > TARGET_CHARS_PER_CHUNK) {
                flush();
                var sentences = p.split(/(?<=[.!?])\s+/);
                var inner = "";
                for (var s = 0; s < sentences.length; s++) {
                    var sent = sentences[s];
                    if ((inner + " " + sent).length > TARGET_CHARS_PER_CHUNK) {
                        if (inner) chunks.push(inner.trim());
                        if (sent.length > TARGET_CHARS_PER_CHUNK) {
                            for (var pos = 0; pos < sent.length; pos += TARGET_CHARS_PER_CHUNK) {
                                chunks.push(sent.substr(pos, TARGET_CHARS_PER_CHUNK));
                            }
                            inner = "";
                        } else {
                            inner = sent;
                        }
                    } else {
                        inner = inner ? inner + " " + sent : sent;
                    }
                }
                if (inner) chunks.push(inner.trim());
                continue;
            }

            if ((current.length + p.length + 2) > TARGET_CHARS_PER_CHUNK) {
                flush();
            }
            current = current ? current + "\n\n" + p : p;
        }
        flush();

        // Merge any sub-MIN_CHARS_PER_CHUNK tail chunks back into the previous
        // chunk. Nano returns kErrorUnknown on near-empty prompts, and a
        // 25-char chunk can't reasonably contain a claim on its own anyway.
        for (var m = chunks.length - 1; m > 0; m--) {
            if (chunks[m].length < MIN_CHARS_PER_CHUNK) {
                chunks[m - 1] = chunks[m - 1] + "\n\n" + chunks[m];
                chunks.splice(m, 1);
            }
        }

        if (chunks.length > MAX_CHUNKS_PER_PAGE) {
            console.log("[FishBarrelAI] page produced " + chunks.length + " chunks; scanning first " + MAX_CHUNKS_PER_PAGE + " only");
            chunks = chunks.slice(0, MAX_CHUNKS_PER_PAGE);
        }
        return chunks;
    }

    // Case-insensitive lookup; returns the original-case substring of source
    // if the quote is genuinely in there, else null. This is the hallucination
    // guard — the Gemini transcript captured Nano inventing quotes that
    // didn't exist in the source, and string-matching kills those.
    function findQuoteInSource(sourceText, candidateQuote) {
        if (!candidateQuote) return null;
        var trimmed = String(candidateQuote).trim();
        if (trimmed.length < 5) return null;
        var idx = sourceText.toLowerCase().indexOf(trimmed.toLowerCase());
        if (idx === -1) return null;
        return sourceText.substr(idx, trimmed.length);
    }

    async function availability() {
        if (typeof LanguageModel === "undefined") return "unavailable";
        try {
            return await LanguageModel.availability({
                expectedInputs: [{ type: "text", languages: ["en"] }],
                expectedOutputs: [{ type: "text", languages: ["en"] }]
            });
        } catch (e) {
            console.log("[FishBarrelAI] availability() threw:", e);
            return "unavailable";
        }
    }

    async function runPromptForChunk(session, prompt) {
        try {
            var raw = await session.prompt(prompt, {
                responseConstraint: VIOLATIONS_SCHEMA,
                omitResponseConstraintInput: true
            });
            var parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (jsonErr) {
                // responseConstraint should make this never happen, but Nano
                // has been known to wrap output in markdown — strip and retry.
                var cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
                parsed = JSON.parse(cleaned);
            }
            if (parsed && Array.isArray(parsed.violations)) return parsed.violations;
            return [];
        } catch (e) {
            console.log("[FishBarrelAI] prompt failed:", e);
            return [];
        }
    }

    async function getSettings() {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: "getSettings" }, function (response) {
                void chrome.runtime.lastError;
                resolve(response || {});
            });
        });
    }

    async function hasAiScannedUrl(url) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: "hasAiScannedUrl", url: url }, function (response) {
                void chrome.runtime.lastError;
                resolve(!!(response && response.scanned));
            });
        });
    }

    function markAiScannedUrl(url) {
        chrome.runtime.sendMessage({ type: "markAiScannedUrl", url: url }, function () {
            void chrome.runtime.lastError;
        });
    }

    function emitClaim(url, quote, reason) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({
                type: "addClaim",
                selectedText: quote,
                url: url,
                textRangeToStringFormatText: quote,
                instanceSelected: 1,
                backgroundInfo: reason || "",
                // Background drops the claim if the same quote+url is already
                // captured. Lets re-scans of dynamic pages stay idempotent.
                dedupByQuote: true
            }, function (response) {
                void chrome.runtime.lastError;
                if (response && typeof FishBarrel !== "undefined" && FishBarrel.HighlightText) {
                    try { FishBarrel.HighlightText(response); } catch (e) { /* highlight failure is non-fatal */ }
                }
                resolve(response || null);
            });
        });
    }

    function getTotalClaims() {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: "getState" }, function (state) {
                void chrome.runtime.lastError;
                var total = (state && state.claimGroup && state.claimGroup.claims) ? state.claimGroup.claims.length : 0;
                resolve(total);
            });
        });
    }

    // Fixed-position toast in the page reporting scan results. Auto-dismisses
    // after a few seconds. Uses the brand yellow so users recognise it as
    // FishBarrel rather than confusing it with the page's own UI.
    function showScanToast(pageCount, totalCount, isRescan) {
        // On re-scans of dynamic pages (carousels etc.) we skip the toast
        // when nothing new was found — would otherwise spam every few
        // seconds as the carousel cycles through content we've already
        // captured.
        if (isRescan && pageCount === 0) return;
        try {
            if (!document.body) return;
            var existing = document.getElementById("__FishBarrelAIToast__");
            if (existing) existing.remove();

            var noun = isRescan ? "new claim" : "claim";
            var msg;
            if (pageCount === 0) {
                msg = "FishBarrel: AI scan complete — no claims found on this page. " + totalCount + " total in this complaint.";
            } else if (pageCount === 1) {
                msg = "FishBarrel: AI scan complete — 1 " + noun + " found on this page. " + totalCount + " total in this complaint.";
            } else {
                msg = "FishBarrel: AI scan complete — " + pageCount + " " + noun + "s found on this page. " + totalCount + " total in this complaint.";
            }

            var t = document.createElement("div");
            t.id = "__FishBarrelAIToast__";
            t.setAttribute("style", [
                "all: initial",
                "position: fixed",
                "top: 16px",
                "right: 16px",
                "z-index: 2147483647",
                "background: #FFF5D6",
                "color: #1F2937",
                "font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                "padding: 12px 16px",
                "border-radius: 10px",
                "box-shadow: 0 6px 20px rgba(15, 23, 42, 0.22)",
                "border: 1px solid #F4B400",
                "max-width: 340px",
                "opacity: 0",
                "transition: opacity 250ms ease"
            ].join("; ") + ";");
            t.textContent = msg;
            document.body.appendChild(t);
            // next frame so the transition fires
            requestAnimationFrame(function () { t.style.opacity = "1"; });

            window.setTimeout(function () {
                t.style.opacity = "0";
                window.setTimeout(function () {
                    if (t && t.parentNode) t.parentNode.removeChild(t);
                }, 350);
            }, pageCount === 0 ? 3000 : 5000);
        } catch (e) {
            // If the page blocks DOM injection, fall back to console only.
            console.log("[FishBarrelAI] could not show toast:", e);
        }
    }

    // Entry point called from FishBarrel.Init(). Runs the first scan (gated by
    // the URL-dedup set) and then installs the dynamic-content watcher.
    async function maybeScan(url, sourceText) {
        console.log("[FishBarrelAI] maybeScan called for", url, "(" + (sourceText || "").length + " chars)");
        try {
            if (!sourceText || sourceText.length < 50) {
                console.log("[FishBarrelAI] skipping: source text too short");
                return;
            }

            if (await hasAiScannedUrl(url)) {
                console.log("[FishBarrelAI] skipping initial scan: URL already scanned this session — call FishBarrelAI.clearScannedUrls() in this console to reset");
                // Don't return — still install the watcher for SPA / carousel
                // updates the user might trigger after revisiting.
            } else {
                markAiScannedUrl(url);
                await performScan(url, sourceText, /*isRescan=*/false);
            }

            watchForDynamicContent(url, sourceText);
        } catch (e) {
            console.log("[FishBarrelAI] maybeScan FAILED:", e);
        }
    }

    // Core scan logic. Called by maybeScan for the initial pass and by the
    // dynamic-content watcher for re-scans.
    async function performScan(url, sourceText, isRescan) {
        try {
            if (!sourceText || sourceText.length < 50) {
                console.log("[FishBarrelAI] performScan: source text too short, skipping");
                return 0;
            }

            var settings = await getSettings();
            if (!isRescan) {
                console.log("[FishBarrelAI] settings — aiEnabled:", settings && settings.aiEnabled, "Country:", settings && settings.Country, "has custom template:", !!(settings && settings.aiPromptTemplate));
            }
            if (!settings || settings.aiEnabled !== "1") {
                console.log("[FishBarrelAI] skipping: AI auto-detect is not enabled in Settings (aiEnabled !== '1')");
                return 0;
            }

            var status = await availability();
            if (status !== "available") {
                console.log("[FishBarrelAI] skipping: model not 'available' (got '" + status + "'). Open Settings to download / check status.");
                return 0;
            }

            var regulator = regulatorForCountry(settings.Country);
            if (!isRescan) console.log("[FishBarrelAI] using regulator framing:", regulator);

            var template = settings.aiPromptTemplate || DEFAULT_PROMPT_TEMPLATE;
            var chunks = chunkText(sourceText);
            console.log("[FishBarrelAI]" + (isRescan ? " RESCAN" : "") + " page split into", chunks.length, "chunk(s); sizes:", chunks.map(function (c) { return c.length; }));
            if (chunks.length === 0) return 0;

            var allViolations = [];
            var firstOrgName = "";
            for (var i = 0; i < chunks.length; i++) {
                // Fresh session per chunk. Nano sometimes returns kErrorUnknown
                // after running a prompt on the same session — isolating chunks
                // avoids one chunk's failure infecting the next.
                var session;
                try {
                    session = await LanguageModel.create({
                        expectedInputs: [{ type: "text", languages: ["en"] }],
                        expectedOutputs: [{ type: "text", languages: ["en"] }],
                        temperature: SESSION_TEMPERATURE,
                        topK: SESSION_TOP_K
                    });
                    if (!isRescan && i === 0) console.log("[FishBarrelAI] session created; contextWindow:", session.contextWindow, "tokens, temperature:", SESSION_TEMPERATURE, "topK:", SESSION_TOP_K);
                } catch (e) {
                    console.log("[FishBarrelAI] LanguageModel.create FAILED on chunk " + (i + 1) + ":", e);
                    continue;
                }

                var prompt = buildPrompt(template, regulator, chunks[i]);
                if (!isRescan) {
                    console.log("[FishBarrelAI] chunk " + (i + 1) + "/" + chunks.length + " prompt (" + prompt.length + " chars, first 400):", prompt.substring(0, 400) + (prompt.length > 400 ? "…" : ""));
                    try {
                        if (typeof session.measureContextUsage === "function") {
                            var cost = await session.measureContextUsage(prompt, { responseConstraint: VIOLATIONS_SCHEMA });
                            console.log("[FishBarrelAI] chunk " + (i + 1) + " context cost:", cost, "/", session.contextWindow);
                        }
                    } catch (e) { /* measure is optional */ }
                }
                var result = await runPromptForChunkVerbose(session, prompt, i + 1);
                if (!firstOrgName && result.organisationName) firstOrgName = result.organisationName;
                allViolations = allViolations.concat(result.violations || []);

                try { session.destroy(); } catch (e) { /* ignore */ }
            }

            if (firstOrgName) {
                setOrgNameIfEmpty(firstOrgName);
            }

            console.log("[FishBarrelAI]" + (isRescan ? " rescan" : ""), "total violations from model:", allViolations.length);

            var emitted = 0;
            var dropped = 0;
            var seenQuotes = {};
            var emitPromises = [];
            for (var v = 0; v < allViolations.length; v++) {
                var violation = allViolations[v];
                if (!violation || !violation.quote) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " dropped: no quote field", violation);
                    dropped++;
                    continue;
                }
                var actual = findQuoteInSource(sourceText, violation.quote);
                if (!actual) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " HALLUCINATED (not in source), dropped. Model said:", JSON.stringify(violation.quote));
                    dropped++;
                    continue;
                }
                if (seenQuotes[actual.toLowerCase()]) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " duplicate, dropped:", JSON.stringify(actual.substring(0, 80)));
                    dropped++;
                    continue;
                }
                if (violation.is_substantive_claim === false) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " SELF-FLAGGED as not a claim by model, dropped:", JSON.stringify(actual.substring(0, 80)));
                    dropped++;
                    continue;
                }
                if (reasonLooksLikeSelfAdmission(violation.reason)) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " reason admits non-claim, dropped:", JSON.stringify(actual.substring(0, 80)), "reason:", violation.reason);
                    dropped++;
                    continue;
                }
                seenQuotes[actual.toLowerCase()] = true;
                console.log("[FishBarrelAI] violation #" + (v + 1) + " ACCEPTED:", JSON.stringify(actual.substring(0, 80)) + (actual.length > 80 ? "…" : ""));
                emitPromises.push(emitClaim(url, actual, violation.reason));
            }

            // Wait for every addClaim to land so we know which were genuinely
            // new vs deduped by the background. emitClaim resolves with
            // { duplicate: true } for already-seen quotes.
            var emitResults = await Promise.all(emitPromises);
            var deduped = 0;
            for (var r = 0; r < emitResults.length; r++) {
                if (emitResults[r] && emitResults[r].duplicate) deduped++;
                else if (emitResults[r]) emitted++;
            }
            dropped += deduped;

            var total = await getTotalClaims();
            console.log("[FishBarrelAI]" + (isRescan ? " rescan" : ""), "done — emitted", emitted, "new,", deduped, "deduped,", dropped - deduped, "filtered, total in complaint:", total, "URL:", url);

            showScanToast(emitted, total, !!isRescan);
            return emitted;
        } catch (e) {
            console.log("[FishBarrelAI] performScan FAILED:", e);
            return 0;
        }
    }

    // Dynamic content watcher. Carousels, AJAX-driven sections, and SPA
    // route changes mutate the DOM without a full navigation; the URL dedup
    // (which uses location.href as key) would otherwise leave new content
    // unscanned. We hash document.body.innerText, watch for mutations, and
    // re-scan when the hash settles to something new.
    //
    // SCAN_DEBOUNCE_MS — quiet period after the LAST mutation before scanning.
    //   Catches the natural "carousel slides in then settles" rhythm.
    // SCAN_MAX_WAIT_MS — force a scan after this even if mutations keep coming
    //   (so pages that mutate continuously still get scanned periodically).
    // MIN_RESCAN_INTERVAL_MS — minimum time between scans of the same URL.
    //   Caps Nano usage to a sane rate.
    var SCAN_DEBOUNCE_MS = 2500;
    var SCAN_MAX_WAIT_MS = 8000;
    var MIN_RESCAN_INTERVAL_MS = 12000;

    function simpleHash(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) - h) + s.charCodeAt(i);
            h |= 0;
        }
        return h;
    }

    function watchForDynamicContent(url, initialText) {
        if (typeof MutationObserver === "undefined" || !document.body) return;
        if (FishBarrelAIWatchers[url]) return; // already watching this URL
        FishBarrelAIWatchers[url] = true;

        var lastHash = simpleHash(initialText || "");
        var lastScanAt = Date.now();
        var debounceTimer = null;
        var maxWaitTimer = null;
        var scanning = false;

        function fireScan() {
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
            if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }

            if (scanning) return;

            var now = Date.now();
            if (now - lastScanAt < MIN_RESCAN_INTERVAL_MS) {
                // Throttled. Reset the debounce so we try again later.
                debounceTimer = window.setTimeout(fireScan, MIN_RESCAN_INTERVAL_MS - (now - lastScanAt));
                return;
            }

            var newText = (document.body && document.body.innerText) || "";
            var newHash = simpleHash(newText);
            if (newHash === lastHash) {
                // No substantive text change; observed mutations were
                // attribute/style/animation noise. Don't burn a model call.
                return;
            }

            lastHash = newHash;
            lastScanAt = now;
            scanning = true;
            console.log("[FishBarrelAI] dynamic content detected on", url, "— re-scanning");
            performScan(url, newText, /*isRescan=*/true).finally(function () {
                scanning = false;
            });
        }

        function schedule() {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = window.setTimeout(fireScan, SCAN_DEBOUNCE_MS);
            if (!maxWaitTimer) {
                maxWaitTimer = window.setTimeout(fireScan, SCAN_MAX_WAIT_MS);
            }
        }

        var observer = new MutationObserver(schedule);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
        console.log("[FishBarrelAI] watching", url, "for dynamic content changes");
    }

    var FishBarrelAIWatchers = {};

    // Verbose variant of runPromptForChunk — logs raw response for debugging.
    // Returns { organisationName, violations }.
    async function runPromptForChunkVerbose(session, prompt, chunkIndex) {
        try {
            var raw = await session.prompt(prompt, {
                responseConstraint: VIOLATIONS_SCHEMA,
                omitResponseConstraintInput: true
            });
            console.log("[FishBarrelAI] chunk " + chunkIndex + " raw response:", raw);
            var parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (jsonErr) {
                var cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
                console.log("[FishBarrelAI] chunk " + chunkIndex + " raw didn't parse; trying cleaned:", cleaned.substring(0, 200));
                parsed = JSON.parse(cleaned);
            }
            var orgName = (parsed && typeof parsed.organisation_name === "string") ? parsed.organisation_name.trim() : "";
            var violations = (parsed && Array.isArray(parsed.violations)) ? parsed.violations : [];
            console.log("[FishBarrelAI] chunk " + chunkIndex + " parsed", violations.length, "violation(s); org name:", JSON.stringify(orgName));
            return { organisationName: orgName, violations: violations };
        } catch (e) {
            console.log("[FishBarrelAI] chunk " + chunkIndex + " prompt FAILED:", e);
            return { organisationName: "", violations: [] };
        }
    }

    // Fire-and-forget message to the background to set the current claim
    // group's company name IF it isn't already populated. Background will
    // ignore the message when the name is already set (so first wins, and
    // user edits in Review aren't overwritten).
    function setOrgNameIfEmpty(name) {
        if (!name || name.length < 3) return;
        var generic = /^(?:unknown|n\/?a|not (?:specified|sure|stated|provided)|none|the (?:business|company|organisation|practitioner))$/i;
        if (generic.test(name.trim())) {
            console.log("[FishBarrelAI] skipping generic org name:", JSON.stringify(name));
            return;
        }
        console.log("[FishBarrelAI] sending org name to background (will only apply if empty):", JSON.stringify(name));
        chrome.runtime.sendMessage({ type: "setOrgNameIfEmpty", name: name }, function () {
            void chrome.runtime.lastError;
        });
    }

    // Console-callable helper to flush the per-session dedup set so the user
    // can retest a page without toggling Capture mode off and on. Usage from
    // any page's DevTools console: FishBarrelAI.clearScannedUrls()
    function clearScannedUrls() {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: "clearAiScannedUrls" }, function (response) {
                void chrome.runtime.lastError;
                console.log("[FishBarrelAI] cleared scanned-URL set");
                resolve(response);
            });
        });
    }

    return {
        maybeScan: maybeScan,
        availability: availability,
        clearScannedUrls: clearScannedUrls,
        DEFAULT_PROMPT_TEMPLATE: DEFAULT_PROMPT_TEMPLATE,
        // exposed for the settings page's prompt template editor
        regulatorForCountry: regulatorForCountry,
        // exposed for tests / debugging
        _internal: {
            buildPrompt: buildPrompt,
            chunkText: chunkText,
            findQuoteInSource: findQuoteInSource,
            VIOLATIONS_SCHEMA: VIOLATIONS_SCHEMA
        }
    };
})();
