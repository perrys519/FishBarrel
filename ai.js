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
        'You are a strict compliance auditor. Analyze the "Source Text" provided below to find violations of {REGULATOR}: claims that a health, medical or psychological treatment is effective without robust scientific evidence (homeopathy, supplements, "natural cures", testimonials about specific conditions, etc).',
        '',
        'CRITICAL RULES:',
        '1. Every "quote" MUST be an exact, word-for-word string match from the "Source Text".',
        '2. Do NOT invent, assume, or paraphrase any quotes. If a sentence is not in the text, do not include it.',
        '3. If no clear violations are found, return: {"violations": []}',
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
                        reason: { type: "string" }
                    },
                    required: ["quote", "reason"]
                }
            }
        },
        required: ["violations"]
    };

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
        try {
            if (!sourceText || sourceText.length < 50) return;

            if (await hasAiScannedUrl(url)) return;
            markAiScannedUrl(url);

            var settings = await getSettings();
            if (!settings || settings.aiEnabled !== "1") return;

            var status = await availability();
            if (status !== "available") {
                console.log("[FishBarrelAI] model status:", status, "— skipping page");
                return;
            }

            var regulator = regulatorForCountry(settings.Country);
            var template = settings.aiPromptTemplate || DEFAULT_PROMPT_TEMPLATE;
            var chunks = chunkText(sourceText);
            if (chunks.length === 0) return;

            var session;
            try {
                session = await LanguageModel.create({
                    expectedInputs: [{ type: "text", languages: ["en"] }],
                    expectedOutputs: [{ type: "text", languages: ["en"] }]
                });
            } catch (e) {
                console.log("[FishBarrelAI] LanguageModel.create failed:", e);
                return;
            }

            var allViolations = [];
            for (var i = 0; i < chunks.length; i++) {
                var prompt = buildPrompt(template, regulator, chunks[i]);
                var violations = await runPromptForChunk(session, prompt);
                allViolations = allViolations.concat(violations || []);
            }
            try { session.destroy(); } catch (e) { /* ignore */ }

            var emitted = 0;
            var seenQuotes = {};
            for (var v = 0; v < allViolations.length; v++) {
                var violation = allViolations[v];
                if (!violation || !violation.quote) continue;
                var actual = findQuoteInSource(sourceText, violation.quote);
                if (!actual) continue;
                if (seenQuotes[actual.toLowerCase()]) continue;
                seenQuotes[actual.toLowerCase()] = true;
                emitClaim(url, actual, violation.reason);
                emitted++;
            }

            if (emitted > 0) {
                console.log("[FishBarrelAI] added " + emitted + " claim(s) from " + url);
            }
        } catch (e) {
            console.log("[FishBarrelAI] maybeScan failed:", e);
        }
    }

    return {
        maybeScan: maybeScan,
        availability: availability,
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
