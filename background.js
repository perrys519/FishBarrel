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
                currentUrl: ClaimGroup.Current ? ClaimGroup.Current.WebsiteUrl() : ""
            };
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
