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

function harvestLinksFromTab(tabId) {
    return new Promise(function (resolve) {
        chrome.tabs.sendMessage(tabId, { type: "harvestLinks" }, function (response) {
            void chrome.runtime.lastError;
            resolve((response && response.links) || []);
        });
    });
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
    console.log("[FishBarrel] spider visiting (" + Spider.pagesScanned + "/" + Spider.maxPages + "):", url);
    var tab;
    try {
        tab = await chrome.tabs.create({ url: url, active: false });
    } catch (e) {
        console.log("[FishBarrel] spider tabs.create failed:", e);
        return;
    }
    Spider.currentTabId = tab.id;

    await waitForTabComplete(tab.id);
    if (!Spider.active) return;

    // Give the AI scan a chance to fire and report back. If it doesn't
    // signal within 25s, move on — better to crawl more pages than to
    // hang forever on one Wix-heavy site.
    await waitForAiScanComplete(25000);
    if (!Spider.active) return;

    var links = await harvestLinksFromTab(tab.id);
    var added = 0;
    for (var i = 0; i < links.length; i++) {
        var n = normaliseSpiderUrl(links[i]);
        if (!n) continue;
        if (!sameHost(n, Spider.rootHost)) continue;
        if (!looksLikePageUrl(n)) continue;
        if (Spider.visited[n]) continue;
        if (Spider.queue.indexOf(n) !== -1) continue;
        Spider.queue.push(n);
        added++;
    }
    console.log("[FishBarrel] spider harvested", links.length, "links from", url + "; queued", added, "new same-host URLs");

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
            // The content script signals this at the end of every successful
            // performScan. The spider uses it as a hand-off cue to harvest
            // links and move to the next URL.
            if (Spider.active && Spider.pendingResolve) {
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
