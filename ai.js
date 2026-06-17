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
        'You are a strict compliance auditor for {REGULATOR}. Two tasks on the Source Text below.',
        '',
        'TASK A — Identify the practitioner, business, clinic or organisation this page belongs to. Look at headings, page title, contact details and signatures. Return the name as `organisation_name`. Empty string if you genuinely cannot tell.',
        '',
        'TASK B — Find EVERY quote on the page that claims a health, medical or psychological treatment is effective for a specific condition without robust scientific evidence. Be thorough — pages typically contain MULTIPLE violations.',
        '',
        'FLAG these patterns (set is_substantive_claim: true):',
        '',
        '1. PATIENT TESTIMONIALS describing personal experience with the treatment for a named condition or symptom. These are the most common violation. Look for quotes (usually in quotation marks, attributed to a named person) that say any of:',
        '   • "The remedy / treatment / medicine worked for my [condition]"',
        '   • "Helped my child / partner / mother with [condition]"',
        '   • "[Treatment] has helped me to deal with my [condition]"',
        '   • "I am now free from / better from / recovered from [condition]"',
        '   • "Within X months / a year, [my condition] showed no signs / was gone"',
        '   • "She doesn\'t need [medication] any more"',
        '   • "Cured my [condition]" / "Relieved my [symptoms]" / "Improved my [condition]"',
        '   • "Took my child to [practitioner] for [condition], worked wonders"',
        '   • Any quote naming a specific illness or symptom (asthma, bronchitis, MS, depression, anger, digestive issues, pain, anxiety, eczema, allergies, etc.) and crediting the treatment with improvement.',
        '',
        '2. DIRECT EFFICACY CLAIMS by the practitioner or the site:',
        '   • "We treat a wide range of medical conditions"',
        '   • "[Treatment] rebalances the body and restores health"',
        '   • "Patients respond particularly well to [treatment]"',
        '   • "Homeopathy can cure [condition]"',
        '   • "[Treatment] is effective for [condition]"',
        '',
        'When in doubt, INCLUDE the quote as a violation. False positives are easy for the user to delete; false negatives let misleading claims pass.',
        '',
        'DO NOT FLAG (set is_substantive_claim: false ONLY for these specific cases):',
        '   • Practitioner qualifications and credentials (degrees, memberships, "X years experience")',
        '   • Service logistics ("I see patients at home", "telephone consultations available", appointment scheduling)',
        '   • Contact details, addresses, phone numbers, opening hours',
        '   • Disclaimers ("I am not a pharmacy", "consult your doctor")',
        '   • Generic statements about a therapy without naming a condition or claiming it works ("Homeopathy is a complementary therapy")',
        '   • Privacy / GDPR / data handling statements',
        '',
        'OUTPUT FORMAT — for each quote:',
        '   • quote: exact word-for-word substring of the Source Text (no paraphrasing, no edits)',
        '   • reason: one sentence on why it violates {REGULATOR}',
        '   • is_substantive_claim: true for FLAG items, false for DO NOT FLAG items',
        '',
        'CRITICAL RULES:',
        '1. Every "quote" MUST appear verbatim in the Source Text. Copy character-for-character including punctuation.',
        '2. Scan the ENTIRE Source Text, including testimonial sections. Do not stop after finding one violation.',
        '3. If no clear efficacy claims exist, return: {"violations": []}',
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

    // Sampling parameters. 0.3 / topK 3 turned out to be too aggressive a
    // clamp — Nano only flagged near-verbatim matches to the example phrases
    // in the prompt, missing semantically-identical testimonials that
    // happened to use different wording. 0.7 / topK 8 keeps the model
    // reasonably stable across re-scans while letting it generalise from
    // example patterns to similar ones. (Default temperature is around 1.0.)
    var SESSION_TEMPERATURE = 0.7;
    var SESSION_TOP_K = 8;

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
                    if (i === 0) console.log("[FishBarrelAI] session created; contextWindow:", session.contextWindow, "tokens, temperature:", SESSION_TEMPERATURE, "topK:", SESSION_TOP_K);
                } catch (e) {
                    console.log("[FishBarrelAI] LanguageModel.create FAILED on chunk " + (i + 1) + ":", e);
                    continue;
                }

                var prompt = buildPrompt(template, regulator, chunks[i]);

                console.groupCollapsed("[FishBarrelAI]" + (isRescan ? " rescan" : "") + " chunk " + (i + 1) + "/" + chunks.length + " — " + prompt.length + " chars in, " + chunks[i].length + " chars source");
                console.log("SOURCE TEXT (chunk " + (i + 1) + "):\n" + chunks[i]);
                console.log("FULL PROMPT (chunk " + (i + 1) + "):\n" + prompt);
                try {
                    if (typeof session.measureContextUsage === "function") {
                        var cost = await session.measureContextUsage(prompt, { responseConstraint: VIOLATIONS_SCHEMA });
                        console.log("context cost:", cost, "/", session.contextWindow);
                    }
                } catch (e) { /* measure is optional */ }

                var result = await runPromptForChunkVerbose(session, prompt, i + 1);
                console.log("PARSED RESPONSE (chunk " + (i + 1) + "):", { organisationName: result.organisationName, violations: result.violations });
                console.groupEnd();

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

    // url -> watcher state { observer, debounceTimer, maxWaitTimer, stopped }
    // — values are objects so we can tear them down individually.
    var FishBarrelAIWatchers = {};

    function watchForDynamicContent(url, initialText) {
        if (typeof MutationObserver === "undefined" || !document.body) return;
        if (FishBarrelAIWatchers[url]) return; // already watching this URL

        var state = {
            observer: null,
            debounceTimer: null,
            maxWaitTimer: null,
            lastHash: simpleHash(initialText || ""),
            lastScanAt: Date.now(),
            scanning: false,
            stopped: false
        };
        FishBarrelAIWatchers[url] = state;

        async function fireScan() {
            if (state.debounceTimer) { clearTimeout(state.debounceTimer); state.debounceTimer = null; }
            if (state.maxWaitTimer) { clearTimeout(state.maxWaitTimer); state.maxWaitTimer = null; }

            if (state.stopped || state.scanning) return;

            // Defence-in-depth: even if the unhighlight signal hasn't reached
            // us yet, double-check with the background that capture is still
            // on before burning a model call. This catches the case where the
            // observer fired between EndCapture and the tear-down message.
            var stillCapturing = await isStillCapturing();
            if (!stillCapturing) {
                console.log("[FishBarrelAI] capture turned off, tearing down watcher for", url);
                stopWatcher(url);
                return;
            }

            var now = Date.now();
            if (now - state.lastScanAt < MIN_RESCAN_INTERVAL_MS) {
                state.debounceTimer = window.setTimeout(fireScan, MIN_RESCAN_INTERVAL_MS - (now - state.lastScanAt));
                return;
            }

            var newText = (document.body && document.body.innerText) || "";
            var newHash = simpleHash(newText);
            if (newHash === state.lastHash) return;

            state.lastHash = newHash;
            state.lastScanAt = now;
            state.scanning = true;
            console.log("[FishBarrelAI] dynamic content detected on", url, "— re-scanning");
            try {
                await performScan(url, newText, /*isRescan=*/true);
            } finally {
                state.scanning = false;
            }
        }

        function schedule() {
            if (state.stopped) return;
            if (state.debounceTimer) clearTimeout(state.debounceTimer);
            state.debounceTimer = window.setTimeout(fireScan, SCAN_DEBOUNCE_MS);
            if (!state.maxWaitTimer) {
                state.maxWaitTimer = window.setTimeout(fireScan, SCAN_MAX_WAIT_MS);
            }
        }

        state.observer = new MutationObserver(schedule);
        state.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
        console.log("[FishBarrelAI] watching", url, "for dynamic content changes");
    }

    function stopWatcher(url) {
        var state = FishBarrelAIWatchers[url];
        if (!state) return;
        state.stopped = true;
        if (state.observer) {
            try { state.observer.disconnect(); } catch (e) { /* ignore */ }
        }
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        if (state.maxWaitTimer) clearTimeout(state.maxWaitTimer);
        delete FishBarrelAIWatchers[url];
    }

    function stopAllWatchers() {
        var urls = Object.keys(FishBarrelAIWatchers);
        if (urls.length === 0) return;
        console.log("[FishBarrelAI] tearing down", urls.length, "watcher(s)");
        for (var i = 0; i < urls.length; i++) {
            stopWatcher(urls[i]);
        }
    }

    function isStillCapturing() {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: "checkCapture" }, function (response) {
                void chrome.runtime.lastError;
                resolve(!!(response && response.capture));
            });
        });
    }

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
        stopAllWatchers: stopAllWatchers,
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
