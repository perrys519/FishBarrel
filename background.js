// FishBarrel service worker. MV3.

importScripts("include.js", "authorities.js");

// ----- In-memory state -------------------------------------------------------
// chrome.storage.session is the source of truth across service-worker restarts;
// these globals are a working copy.

var CurrentComplaint = NewComplaint();

function NewComplaint() {
    return {
        AuthorityKey: null,
        Body: null,
        Filled: false,
        FormData: {}
    };
}

var stateReady = restoreState();

// URLs the AI scanner has already processed this capture session. Cleared on
// Init / ClearCapture so a fresh round re-scans everything.
var AiScannedUrls = {};

// Site spider state. Holds the BFS queue, visited set, and current background
// tab while a crawl is in progress. Cleared on Init / ClearCapture and on
// spiderStop. Only one spider runs at a time.
var Spider = {
    active: false,
    rootHost: null,
    queue: [],
    visited: {},
    maxPages: 50,
    pagesScanned: 0,
    claimsAtStart: 0,
    currentTabId: null,
    pendingResolve: null,
    pendingTimeout: null
};

function canonicalHost(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
        return null;
    }
}

function sameHost(url, refHost) {
    var h = canonicalHost(url);
    if (!h || !refHost) return false;
    if (h === refHost) return true;
    if (h.endsWith("." + refHost)) return true;
    if (refHost.endsWith("." + h)) return true;
    return false;
}

function normaliseSpiderUrl(rawUrl) {
    try {
        var u = new URL(rawUrl);
        if (!/^https?:$/i.test(u.protocol)) return null;
        u.hash = "";
        // Strip trailing slash for a stable visited-set key.
        var s = u.href;
        if (s.endsWith("/")) s = s.slice(0, -1);
        return s;
    } catch (e) {
        return null;
    }
}

function looksLikePageUrl(url) {
    try {
        var u = new URL(url);
        var path = (u.pathname || "").toLowerCase();
        // Skip common non-HTML asset extensions.
        if (/\.(pdf|png|jpe?g|gif|webp|svg|ico|css|js|zip|mp[34]|mov|avi|woff2?|ttf|eot|xml|rss|atom)(?:$|\?)/.test(path)) return false;
        return true;
    } catch (e) {
        return false;
    }
}

function waitForTabComplete(tabId) {
    return new Promise(function (resolve) {
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.onRemoved.removeListener(removedListener);
            resolve();
        }
        function listener(updatedTabId, changeInfo) {
            if (updatedTabId === tabId && changeInfo.status === "complete") finish();
        }
        function removedListener(removedTabId) {
            if (removedTabId === tabId) finish();
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.onRemoved.addListener(removedListener);
        // Safety: 30s hard cap even if Chrome never fires complete.
        setTimeout(finish, 30000);
    });
}

function waitForAiScanComplete(maxMs) {
    return new Promise(function (resolve) {
        Spider.pendingResolve = resolve;
        Spider.pendingTimeout = setTimeout(function () {
            Spider.pendingResolve = null;
            Spider.pendingTimeout = null;
            resolve("timeout");
        }, maxMs);
    });
}

// Harvest anchors from every frame in the tab. Wix and other site-builder
// platforms render content inside nested cross-origin iframes; the top
// document often has zero <a> tags of its own. chrome.scripting with
// allFrames:true lets us reach every frame the extension has host
// permissions for, so we surface those iframe links too.
async function harvestLinksFromTab(tabId) {
    var seen = {};
    var combined = [];
    try {
        var results = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: function () {
                var out = [];
                try {
                    var anchors = document.querySelectorAll('a[href]');
                    for (var i = 0; i < anchors.length; i++) {
                        var h = anchors[i].href || "";
                        if (h && /^https?:/i.test(h)) out.push(h);
                    }
                } catch (e) { /* DOM access denied; return what we have */ }
                return out;
            }
        });
        var frameCounts = [];
        for (var i = 0; i < results.length; i++) {
            var arr = (results[i] && results[i].result) || [];
            frameCounts.push("frame" + (results[i].frameId != null ? results[i].frameId : "?") + ":" + arr.length);
            for (var j = 0; j < arr.length; j++) {
                try {
                    var u = new URL(arr[j]);
                    u.hash = "";
                    var n = u.href;
                    if (!seen[n]) { seen[n] = true; combined.push(n); }
                } catch (e) { /* malformed href, skip */ }
            }
        }
        if (frameCounts.length > 0) {
            console.log("[FishBarrel] spider harvest tab", tabId, "frame counts:", frameCounts.join(", "));
        }
    } catch (e) {
        console.log("[FishBarrel] spider executeScript harvest failed on tab", tabId + ":", e);
    }
    return combined;
}

async function spiderStart(rootUrl) {
    if (Spider.active) return { error: "already-running" };
    var normalised = normaliseSpiderUrl(rootUrl);
    if (!normalised) return { error: "bad-url" };
    if (!looksLikePageUrl(normalised)) return { error: "not-a-page" };

    // Auto-enable Capture mode if it isn't on. Spidering without capture
    // would just open and close tabs to no effect.
    if (!ClaimGroup.IsCollecting) {
        await Init();
    }

    Spider.active = true;
    Spider.rootHost = canonicalHost(normalised);
    Spider.queue = [normalised];
    Spider.visited = {};
    Spider.pagesScanned = 0;
    Spider.claimsAtStart = (ClaimGroup.Current && ClaimGroup.Current.claims) ? ClaimGroup.Current.claims.length : 0;

    console.log("[FishBarrel] spider starting from", normalised, "(host:", Spider.rootHost + ", max:", Spider.maxPages + " pages)");

    updateSpiderBadge();

    // Run async — don't make spiderStart's caller wait for the whole crawl.
    spiderLoop();

    return { ok: true, rootHost: Spider.rootHost, maxPages: Spider.maxPages };
}

function spiderStop() {
    if (!Spider.active) return;
    Spider.active = false;

    if (Spider.pendingTimeout) clearTimeout(Spider.pendingTimeout);
    if (Spider.pendingResolve) {
        var resolve = Spider.pendingResolve;
        Spider.pendingResolve = null;
        Spider.pendingTimeout = null;
        resolve("stopped");
    }

    if (Spider.currentTabId) {
        var tabId = Spider.currentTabId;
        Spider.currentTabId = null;
        chrome.tabs.remove(tabId, function () { void chrome.runtime.lastError; });
    }

    var totalClaims = (ClaimGroup.Current && ClaimGroup.Current.claims) ? ClaimGroup.Current.claims.length : 0;
    var added = totalClaims - Spider.claimsAtStart;
    console.log("[FishBarrel] spider stopped — pages scanned:", Spider.pagesScanned + ", claims added during crawl:", added + ", total claims:", totalClaims);

    updateSpiderBadge();
}

async function spiderLoop() {
    while (Spider.active && Spider.queue.length > 0 && Spider.pagesScanned < Spider.maxPages) {
        var url = Spider.queue.shift();
        if (!url || Spider.visited[url]) continue;
        Spider.visited[url] = true;
        Spider.pagesScanned++;

        try {
            await spiderVisit(url);
        } catch (e) {
            console.log("[FishBarrel] spider error on", url, e);
        }
    }
    spiderStop();
}

async function spiderVisit(url) {
    console.log("[FishBarrel] spider VISIT (" + Spider.pagesScanned + "/" + Spider.maxPages + "):", url);
    var tab;
    try {
        tab = await chrome.tabs.create({ url: url, active: false });
        console.log("[FishBarrel] spider opened tab", tab.id);
    } catch (e) {
        console.log("[FishBarrel] spider tabs.create failed:", e);
        return;
    }
    Spider.currentTabId = tab.id;

    console.log("[FishBarrel] spider waiting for tab", tab.id, "to finish loading");
    await waitForTabComplete(tab.id);
    if (!Spider.active) return;
    console.log("[FishBarrel] spider tab", tab.id, "load complete");

    // Give the AI scan a chance to fire and report back. With the always-fire
    // aiScanComplete signal in maybeScan this normally resolves in < 1 s for
    // already-scanned URLs and < 10 s for fresh ones. The 25 s timeout is a
    // safety net for pages where the content script never reports back.
    var waitStart = Date.now();
    var reason = await waitForAiScanComplete(25000);
    if (!Spider.active) return;
    console.log("[FishBarrel] spider tab", tab.id, "scan wait resolved via:", reason, "after", Date.now() - waitStart, "ms");

    // Settling window. Wix and other client-rendered sites finish hydrating
    // AFTER document-idle, which is when our content script first runs. The
    // initial scan therefore catches a half-rendered page; the
    // MutationObserver picks up the rest and re-scans. We hold the tab open
    // an extra few seconds so those rescans (and their addClaim messages)
    // land before we move on and close the tab.
    var elapsed = Date.now() - waitStart;
    var settleMs = 6000;
    if (elapsed < settleMs) {
        var extra = settleMs - elapsed;
        console.log("[FishBarrel] spider tab", tab.id, "settling for an extra", extra, "ms to catch hydration rescans");
        await new Promise(function (r) { setTimeout(r, extra); });
    }
    if (!Spider.active) return;

    var links = await harvestLinksFromTab(tab.id);
    var added = 0;
    var sameHostCount = 0;
    var alreadyVisitedCount = 0;
    var alreadyQueuedCount = 0;
    var assetCount = 0;
    for (var i = 0; i < links.length; i++) {
        var n = normaliseSpiderUrl(links[i]);
        if (!n) continue;
        if (!sameHost(n, Spider.rootHost)) continue;
        sameHostCount++;
        if (!looksLikePageUrl(n)) { assetCount++; continue; }
        if (Spider.visited[n]) { alreadyVisitedCount++; continue; }
        if (Spider.queue.indexOf(n) !== -1) { alreadyQueuedCount++; continue; }
        Spider.queue.push(n);
        added++;
    }
    console.log("[FishBarrel] spider link harvest from tab", tab.id + ":",
        "raw=" + links.length,
        "sameHost=" + sameHostCount,
        "queuedNew=" + added,
        "alreadyVisited=" + alreadyVisitedCount,
        "alreadyQueued=" + alreadyQueuedCount,
        "skippedAssets=" + assetCount,
        "queueLen=" + Spider.queue.length);

    updateSpiderBadge();

    if (Spider.currentTabId === tab.id) {
        Spider.currentTabId = null;
        chrome.tabs.remove(tab.id, function () { void chrome.runtime.lastError; });
    }
}

async function restoreState() {
    var stored = await new Promise(function (resolve) {
        chrome.storage.session.get(["claimGroup", "isCollecting", "currentComplaint", "aiScannedUrls"], function (items) {
            resolve(items || {});
        });
    });
    ClaimGroup.Current = ClaimGroup.Rehydrate(stored.claimGroup);
    ClaimGroup.IsCollecting = !!stored.isCollecting;
    if (stored.currentComplaint) CurrentComplaint = stored.currentComplaint;
    AiScannedUrls = stored.aiScannedUrls || {};
    updateIcon();
    // Ensure storage has a sensible Country default for fresh installs.
    var localDefaults = await FBStorage.getLocal(["Country"]);
    if (!localDefaults.Country) {
        await FBStorage.setLocal({ Country: "UK" });
    }
}

function persistState() {
    var snapshot = {
        claimGroup: ClaimGroup.Current,
        isCollecting: ClaimGroup.IsCollecting,
        currentComplaint: CurrentComplaint,
        aiScannedUrls: AiScannedUrls
    };
    chrome.storage.session.set(snapshot);
}

function updateIcon() {
    chrome.action.setIcon({ path: ClaimGroup.IsCollecting ? "icon-active.png" : "icon.png" });
}

// Toolbar badge showing live spider progress. Format: "scanned/total" where
// total = scanned + queued (i.e. every URL we've discovered so far). Both
// numbers grow as new same-host links are found on each visited page.
function updateSpiderBadge() {
    try {
        if (Spider.active) {
            var total = Spider.pagesScanned + Spider.queue.length;
            chrome.action.setBadgeBackgroundColor({ color: "#F4B400" });
            if (chrome.action.setBadgeTextColor) {
                chrome.action.setBadgeTextColor({ color: "#1F2937" });
            }
            chrome.action.setBadgeText({ text: Spider.pagesScanned + "/" + total });
        } else {
            chrome.action.setBadgeText({ text: "" });
        }
    } catch (e) { /* badge APIs may be unavailable in older Chrome */ }
}

// ----- Capture controls ------------------------------------------------------

async function Init() {
    ClaimGroup.Current = new ClaimGroup();
    AiScannedUrls = {};
    await Resume();
}

async function Resume() {
    ClaimGroup.IsCollecting = true;
    updateIcon();
    persistState();

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id, allFrames: true },
                func: function () { try { FishBarrel.Init(); } catch (e) { /* content script may not be present in this frame */ } }
            });
        } catch (e) {
            // executeScript fails on restricted pages (chrome://, etc); that's fine.
        }
    }
}

function PauseCapture() {
    ClaimGroup.IsCollecting = false;
    updateIcon();
    persistState();
}

async function EndCapture() {
    // Stop any in-progress spider FIRST so it doesn't open more tabs after
    // capture has been turned off.
    if (Spider.active) spiderStop();

    ClaimGroup.IsCollecting = false;
    updateIcon();
    persistState();

    var windows = await chrome.windows.getAll({ populate: true });
    for (var w = 0; w < windows.length; w++) {
        var tabs = windows[w].tabs || [];
        for (var t = 0; t < tabs.length; t++) {
            var tab = tabs[t];
            if (tab.url && tab.url.indexOf("http") === 0) {
                try {
                    chrome.tabs.sendMessage(tab.id, { type: "unhighlightAll" }, function () {
                        void chrome.runtime.lastError;
                    });
                } catch (e) { /* tab may have closed */ }
            }
        }
    }
}

function ClearCapture() {
    EndCapture();
    ClaimGroup.Current = new ClaimGroup();
    CurrentComplaint = NewComplaint();
    AiScannedUrls = {};
    persistState();
}

function GroupExists() {
    return !!(ClaimGroup.Current && ClaimGroup.Current.claims && ClaimGroup.Current.claims.length > 0);
}

function GetStatusText() {
    return ClaimGroup.IsCollecting ? "Currently capturing claims" : "Inactive";
}

async function CheckSettingsCompleted() {
    var s = await FBStorage.getLocal(["firstName"]);
    return !!s.firstName;
}

// ----- Compose / submit ------------------------------------------------------

async function ComposeComplaint(key, overrideBody) {
    CurrentComplaint.Filled = false;

    if (!(await CheckSettingsCompleted())) {
        // The UI page that called us shows its own alert; just bail.
        return { error: "settings-incomplete" };
    }

    PauseCapture();

    CurrentComplaint.AuthorityKey = key;

    var settings = await FBStorage.getLocal(null);

    if (overrideBody) {
        CurrentComplaint.Body = overrideBody;
    } else {
        CurrentComplaint.Body = ClaimGroup.Current.GenerateComplaintText(key, settings);
        if (CurrentComplaint.Body == null) {
            return { error: "no-template" };
        }
    }

    persistState();

    var authority = Authorities[key];
    if (!authority) return { error: "unknown-authority" };

    // ComposeComplaint runs in the service-worker context. Authorities use
    // chrome.tabs.update / chrome.tabs.create to navigate to the regulator's
    // form. The form-side autofill lives in authorities.js loaded as a content
    // script, and is triggered when the page loads.
    try {
        authority.ComposeComplaint();
    } catch (e) {
        console.error("Authority.ComposeComplaint failed:", e);
        return { error: "authority-failed" };
    }
    return { ok: true };
}

// ----- Message router --------------------------------------------------------

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    handleMessage(request, sender).then(function (result) {
        try { sendResponse(result); } catch (_) { /* port closed */ }
    }, function (err) {
        console.error("background message error:", err, request);
        try { sendResponse({ error: String(err) }); } catch (_) { /* port closed */ }
    });
    return true; // async response
});

async function handleMessage(request, sender) {
    await stateReady;
    var type = request.type;

    switch (type) {
        case "getState": {
            return {
                isCollecting: ClaimGroup.IsCollecting,
                groupExists: GroupExists(),
                statusText: GetStatusText(),
                claimGroup: ClaimGroup.Current,
                currentUrl: ClaimGroup.Current ? ClaimGroup.Current.WebsiteUrl() : "",
                spider: Spider.active ? {
                    active: true,
                    rootHost: Spider.rootHost,
                    pagesScanned: Spider.pagesScanned,
                    maxPages: Spider.maxPages,
                    queueRemaining: Spider.queue.length
                } : { active: false }
            };
        }

        case "spiderStart":
            return await spiderStart(request.url);

        case "spiderStop":
            spiderStop();
            return { ok: true };

        case "aiScanComplete": {
            // maybeScan fires this once per page load. The spider uses it as
            // the hand-off cue to harvest links and move on. We only resolve
            // when the message comes from the spider's current tab —
            // otherwise a rescan in some other tab would prematurely advance
            // the crawl.
            var fromSpiderTab = sender && sender.tab && Spider.currentTabId
                && sender.tab.id === Spider.currentTabId;
            if (Spider.active && Spider.pendingResolve && request.initial && fromSpiderTab) {
                console.log("[FishBarrel] spider got aiScanComplete from tab", sender.tab.id,
                    "(alreadyScanned:", request.alreadyScanned + ", skipped:", request.skipped + ")");
                if (Spider.pendingTimeout) clearTimeout(Spider.pendingTimeout);
                var resolve = Spider.pendingResolve;
                Spider.pendingResolve = null;
                Spider.pendingTimeout = null;
                resolve("scan-complete");
            }
            return { ok: true };
        }
        case "init":          await Init(); return { ok: true };
        case "resume":        await Resume(); return { ok: true };
        case "pauseCapture":  PauseCapture(); return { ok: true };
        case "endCapture":    await EndCapture(); return { ok: true };
        case "clearCapture":  ClearCapture(); return { ok: true };

        case "checkSettingsCompleted":
            return { completed: await CheckSettingsCompleted() };

        case "groupExists":
            return { exists: GroupExists() };

        case "composeComplaint":
            return await ComposeComplaint(request.key, request.body);

        case "updateOrgName": {
            if (ClaimGroup.Current) {
                ClaimGroup.Current._CompanyName = request.name || "";
                persistState();
            }
            return { ok: true };
        }

        case "updateBackgroundInfo": {
            if (ClaimGroup.Current) {
                var claim = ClaimGroup.Current.GetById(request.claimId);
                if (claim) claim.backgroundInfo = request.info || "";
                persistState();
            }
            return { ok: true };
        }

        case "deleteClaim": {
            if (ClaimGroup.Current) {
                ClaimGroup.Current.DeleteClaim(request.claimId);
                persistState();
            }
            return { ok: true };
        }

        case "registerFormDataChange":
            CurrentComplaint.FormData[request.name] = request.value;
            persistState();
            return { ok: true };

        case "setComplaintFilled":
            CurrentComplaint.Filled = true;
            persistState();
            return { ok: true };

        case "complaintSent": {
            // The user clicked submit on the regulator's form. Without the
            // FishBarrel backend there's nothing to upload; clear in-progress
            // complaint state so the next round starts clean.
            CurrentComplaint = NewComplaint();
            persistState();
            return { ok: true };
        }

        case "addClaim": {
            if (!ClaimGroup.IsCollecting) return { ok: false };
            if (!ClaimGroup.Current) ClaimGroup.Current = new ClaimGroup();

            // request.dedupByQuote is set by the AI scanner so re-scans of
            // dynamic pages (carousels, AJAX updates) don't add the same
            // testimonial twice. Manual selections leave it false so a user
            // can re-select the same passage if they want.
            if (request.dedupByQuote && request.selectedText) {
                var key = String(request.selectedText).trim().toLowerCase();
                for (var i = 0; i < ClaimGroup.Current.claims.length; i++) {
                    var existing = ClaimGroup.Current.claims[i];
                    if (existing.url === request.url
                        && existing.claimText
                        && existing.claimText.trim().toLowerCase() === key) {
                        return { duplicate: true, claimIndex: i, id: existing.id };
                    }
                }
            }

            // request.backgroundInfo is set by the AI scanner with the LLM's
            // per-claim reasoning. The manual OnMouseUp flow doesn't pass it,
            // so it defaults to "" — the user fills it in on the review page.
            ClaimGroup.Current.AddClaim(
                request.selectedText,
                request.url,
                request.textRangeToStringFormatText,
                request.instanceSelected,
                request.backgroundInfo || "",
                request.id || null,
                false
            );
            persistState();
            var claim = ClaimGroup.Current.claims[ClaimGroup.Current.claims.length - 1];
            return {
                textToHighlight: claim.textRangeToStringFormatText,
                instanceSelected: claim.instanceSelected,
                claimIndex: ClaimGroup.Current.claims.length - 1,
                id: claim.id
            };
        }

        case "hasAiScannedUrl":
            return { scanned: !!AiScannedUrls[request.url] };

        case "markAiScannedUrl":
            AiScannedUrls[request.url] = true;
            persistState();
            return { ok: true };

        case "clearAiScannedUrls":
            AiScannedUrls = {};
            persistState();
            return { ok: true };

        case "setOrgNameIfEmpty": {
            // The AI scanner identifies the practitioner/business on each
            // page. We set the claim group's company name on the first
            // non-empty answer; later pages don't overwrite, and user edits
            // in Review (via updateOrgName) take precedence.
            if (!ClaimGroup.Current) ClaimGroup.Current = new ClaimGroup();
            if (!ClaimGroup.Current._CompanyName && request.name) {
                ClaimGroup.Current._CompanyName = String(request.name).trim();
                console.log("[FishBarrel] org name set from AI:", ClaimGroup.Current._CompanyName);
                persistState();
            }
            return { ok: true };
        }

        case "getSettings": {
            return await FBStorage.getLocal(null);
        }

        // --- Automation harness support ----------------------------------
        // These three messages are only used by the in-extension automation
        // page (automation.html). The harness reads the user's real settings,
        // backs them up in memory, swaps in a synthetic test identity, runs
        // its audit, then writes the backup straight back. No persistence on
        // the SW side — the backup payload always travels with the request.

        case "setSyntheticSettings": {
            // request.settings is a flat key/value object to merge into
            // chrome.storage.local. Existing keys not in the payload are
            // left alone, so the user's complaint templates survive a run.
            if (!request.settings || typeof request.settings !== "object") {
                return { error: "bad-payload" };
            }
            await FBStorage.setLocal(request.settings);
            return { ok: true };
        }

        case "restoreSettings": {
            // request.backup is the verbatim object the harness captured via
            // getSettings before the audit. We clear synthetic-only keys
            // (anything in the backup is the source of truth) and write the
            // backup. Used by both the manual Restore button and the page's
            // beforeunload handler.
            if (!request.backup || typeof request.backup !== "object") {
                return { error: "bad-payload" };
            }
            // Clear first so synthetic-only keys (none today, but if added
            // later) are removed before we re-write the real values.
            if (request.clearFirst) {
                await FBStorage.clearLocal();
            }
            await FBStorage.setLocal(request.backup);
            return { ok: true };
        }

        case "listAuthorities": {
            // For the audit harness. Returns enough metadata per authority
            // to walk the list and call composeComplaint for each.
            var out = [];
            for (var k in Authorities) {
                var a = Authorities[k];
                out.push({
                    key: k,
                    Country: a.Country || null,
                    Name: a.Name || null,
                    broken: !!a.broken,
                    brokenReason: a.brokenReason || null,
                    helpUrl: a.helpUrl || null
                });
            }
            return { authorities: out };
        }

        case "openTab": {
            // Create a victim tab so composeComplaint has somewhere safe to
            // navigate without clobbering the bridge tab. Returns the tab id
            // so the harness can target snapshotForm/closeTab at it.
            return await new Promise(function (resolve) {
                chrome.tabs.create({
                    url: request.url || "about:blank",
                    active: request.active !== false
                }, function (tab) {
                    resolve({ tabId: tab.id, url: tab.url });
                });
            });
        }

        case "closeTab": {
            if (typeof request.tabId !== "number") return { error: "missing-tabId" };
            return await new Promise(function (resolve) {
                chrome.tabs.remove(request.tabId, function () {
                    void chrome.runtime.lastError;
                    resolve({ ok: true });
                });
            });
        }

        case "activateTab": {
            if (typeof request.tabId !== "number") return { error: "missing-tabId" };
            return await new Promise(function (resolve) {
                chrome.tabs.update(request.tabId, { active: true }, function (tab) {
                    void chrome.runtime.lastError;
                    resolve({ ok: true, url: tab && tab.url });
                });
            });
        }

        case "waitTabComplete": {
            // Resolves once the named tab finishes loading (or after a
            // timeout). Used by the audit harness to know when a regulator's
            // form is ready to snapshot.
            if (typeof request.tabId !== "number") return { error: "missing-tabId" };
            var tabId = request.tabId;
            var timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : 20000;
            return await new Promise(function (resolve) {
                var done = false;
                function finish(reason) {
                    if (done) return;
                    done = true;
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    chrome.tabs.onRemoved.removeListener(onRemoved);
                    chrome.tabs.get(tabId, function (tab) {
                        void chrome.runtime.lastError;
                        resolve({ reason: reason, url: tab && tab.url, status: tab && tab.status });
                    });
                }
                function onUpdated(updatedTabId, changeInfo) {
                    if (updatedTabId === tabId && changeInfo.status === "complete") finish("complete");
                }
                function onRemoved(removedTabId) {
                    if (removedTabId === tabId) finish("removed");
                }
                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.tabs.onRemoved.addListener(onRemoved);
                // Maybe already complete.
                chrome.tabs.get(tabId, function (tab) {
                    if (tab && tab.status === "complete") finish("already-complete");
                });
                setTimeout(function () { finish("timeout"); }, timeoutMs);
            });
        }

        case "snapshotForm": {
            // Proxy the form-snapshot request to a specific tab's content
            // script. Returns the FormRecorder JSON or { error }.
            if (typeof request.tabId !== "number") {
                return { error: "missing-tabId" };
            }
            return await new Promise(function (resolve) {
                chrome.tabs.sendMessage(request.tabId, { type: "snapshotForm" }, function (response) {
                    if (chrome.runtime.lastError) {
                        resolve({ error: chrome.runtime.lastError.message || "sendMessage-failed" });
                        return;
                    }
                    resolve(response || { error: "no-response" });
                });
            });
        }

        case "getNextClaimForUrl": {
            // Used by content script to walk through claims for the current URL.
            var startIndex = request.claimIndex || 0;
            if (!ClaimGroup.Current) return null;
            for (var i = startIndex; i < ClaimGroup.Current.claims.length; i++) {
                var c = ClaimGroup.Current.claims[i];
                if (c.url == request.url) {
                    return {
                        textToHighlight: c.textRangeToStringFormatText,
                        instanceSelected: c.instanceSelected,
                        claimIndex: i,
                        id: c.id
                    };
                }
            }
            return null;
        }

        case "checkCapture":
            return { capture: ClaimGroup.IsCollecting };

        case "getExistingClaimsForUrl":
            // The community-shared "previously reported claims" feature lived on
            // the FishBarrel server. With the server gone this is a no-op stub
            // so the content script's highlight pass simply finds nothing.
            return { claims: [] };

        case "getComplaintReady": {
            if (CurrentComplaint.AuthorityKey != request.authority) return null;
            var settings = await FBStorage.getLocal(null);
            return {
                body: CurrentComplaint.Body,
                organisationName: ClaimGroup.Current ? ClaimGroup.Current.CompanyName(true) : "",
                settings: settings,
                settingsAttached: true,
                WebsiteUrl: ClaimGroup.Current ? ClaimGroup.Current.WebsiteUrl() : "",
                ScreenshotUrl: "",
                formFilled: false,
                CurrentComplaintFilled: !!CurrentComplaint.Filled
            };
        }

        default:
            return null;
    }
}

// Reset the icon to its default on install so a leftover active icon from a
// previous install doesn't mislead the user.
chrome.runtime.onInstalled.addListener(function () {
    updateIcon();
});
