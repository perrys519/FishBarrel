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
        'You are a strict compliance auditor. Analyze the "Source Text" below to find violations of {REGULATOR}: quotes that claim a health, medical or psychological treatment is effective for a specific condition without robust scientific evidence. Examples of WHAT TO FLAG:',
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
        required: ["violations"]
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

    // Conservative character budget per chunk. Nano's per-prompt cap is
    // ~1024 tokens (~3.5–4 KB of English text). We use measureContextUsage
    // when a session is available, but this is the starting upper bound for
    // chunk-splitting before we even create the session.
    var TARGET_CHARS_PER_CHUNK = 3000;
    var MAX_CHUNKS_PER_PAGE = 5;

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
        chrome.runtime.sendMessage({
            type: "addClaim",
            selectedText: quote,
            url: url,
            textRangeToStringFormatText: quote,
            instanceSelected: 1,
            backgroundInfo: reason || ""
        }, function (response) {
            void chrome.runtime.lastError;
            if (response && typeof FishBarrel !== "undefined" && FishBarrel.HighlightText) {
                try { FishBarrel.HighlightText(response); } catch (e) { /* highlight failure is non-fatal */ }
            }
        });
    }

    async function maybeScan(url, sourceText) {
        console.log("[FishBarrelAI] maybeScan called for", url, "(" + (sourceText || "").length + " chars)");
        try {
            if (!sourceText || sourceText.length < 50) {
                console.log("[FishBarrelAI] skipping: source text too short");
                return;
            }

            if (await hasAiScannedUrl(url)) {
                console.log("[FishBarrelAI] skipping: URL already scanned this session — call FishBarrelAI.clearScannedUrls() in this console to reset");
                return;
            }
            markAiScannedUrl(url);

            var settings = await getSettings();
            console.log("[FishBarrelAI] settings — aiEnabled:", settings && settings.aiEnabled, "Country:", settings && settings.Country, "has custom template:", !!(settings && settings.aiPromptTemplate));
            if (!settings || settings.aiEnabled !== "1") {
                console.log("[FishBarrelAI] skipping: AI auto-detect is not enabled in Settings (aiEnabled !== '1')");
                return;
            }

            var status = await availability();
            console.log("[FishBarrelAI] LanguageModel availability:", status);
            if (status !== "available") {
                console.log("[FishBarrelAI] skipping: model not 'available'. Open Settings to download / check status.");
                return;
            }

            var regulator = regulatorForCountry(settings.Country);
            console.log("[FishBarrelAI] using regulator framing:", regulator);

            var template = settings.aiPromptTemplate || DEFAULT_PROMPT_TEMPLATE;
            var chunks = chunkText(sourceText);
            console.log("[FishBarrelAI] page split into", chunks.length, "chunk(s); sizes:", chunks.map(function (c) { return c.length; }));
            if (chunks.length === 0) {
                console.log("[FishBarrelAI] skipping: no chunks produced");
                return;
            }

            var session;
            try {
                session = await LanguageModel.create({
                    expectedInputs: [{ type: "text", languages: ["en"] }],
                    expectedOutputs: [{ type: "text", languages: ["en"] }]
                });
                console.log("[FishBarrelAI] session created; contextWindow:", session.contextWindow, "tokens");
            } catch (e) {
                console.log("[FishBarrelAI] LanguageModel.create FAILED:", e);
                return;
            }

            var allViolations = [];
            for (var i = 0; i < chunks.length; i++) {
                var prompt = buildPrompt(template, regulator, chunks[i]);
                console.log("[FishBarrelAI] chunk " + (i + 1) + "/" + chunks.length + " prompt (" + prompt.length + " chars, first 400):", prompt.substring(0, 400) + (prompt.length > 400 ? "…" : ""));
                try {
                    if (typeof session.measureContextUsage === "function") {
                        var cost = await session.measureContextUsage(prompt, { responseConstraint: VIOLATIONS_SCHEMA });
                        console.log("[FishBarrelAI] chunk " + (i + 1) + " context cost:", cost, "/", session.contextWindow);
                    }
                } catch (e) { /* measure is optional */ }
                var violations = await runPromptForChunkVerbose(session, prompt, i + 1);
                allViolations = allViolations.concat(violations || []);
            }
            try { session.destroy(); } catch (e) { /* ignore */ }

            console.log("[FishBarrelAI] total violations from model:", allViolations.length);
            if (allViolations.length === 0) {
                console.log("[FishBarrelAI] model returned no violations for this page. URL stays marked so we don't loop — call FishBarrelAI.clearScannedUrls() to retry.");
                return;
            }

            var emitted = 0;
            var dropped = 0;
            var seenQuotes = {};
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
                // Sense-check 1: the model committed to whether this is actually
                // a substantive claim. Trust that boolean over the fact that it
                // bothered to include the quote at all.
                if (violation.is_substantive_claim === false) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " SELF-FLAGGED as not a claim by model, dropped:", JSON.stringify(actual.substring(0, 80)));
                    dropped++;
                    continue;
                }
                // Sense-check 2: even when is_substantive_claim is true or
                // missing, the reason text often gives the model away —
                // "factual statement of qualifications", "not a claim of
                // efficacy", "could be interpreted as", etc.
                if (reasonLooksLikeSelfAdmission(violation.reason)) {
                    console.log("[FishBarrelAI] violation #" + (v + 1) + " reason admits non-claim, dropped:", JSON.stringify(actual.substring(0, 80)), "reason:", violation.reason);
                    dropped++;
                    continue;
                }
                seenQuotes[actual.toLowerCase()] = true;
                console.log("[FishBarrelAI] violation #" + (v + 1) + " ACCEPTED:", JSON.stringify(actual.substring(0, 80)) + (actual.length > 80 ? "…" : ""));
                emitClaim(url, actual, violation.reason);
                emitted++;
            }

            console.log("[FishBarrelAI] done — emitted", emitted, "claim(s),", dropped, "dropped, for", url);
        } catch (e) {
            console.log("[FishBarrelAI] maybeScan FAILED:", e);
        }
    }

    // Verbose variant of runPromptForChunk — logs raw response for debugging.
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
            if (parsed && Array.isArray(parsed.violations)) {
                console.log("[FishBarrelAI] chunk " + chunkIndex + " parsed", parsed.violations.length, "violation(s)");
                return parsed.violations;
            }
            console.log("[FishBarrelAI] chunk " + chunkIndex + " parsed but no violations array:", parsed);
            return [];
        } catch (e) {
            console.log("[FishBarrelAI] chunk " + chunkIndex + " prompt FAILED:", e);
            return [];
        }
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
