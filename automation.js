// FishBarrel automation control surface. Loaded by automation.html.
//
// Provides window.FBControl with helpers that wrap chrome.runtime.sendMessage
// so an audit harness can drive the popup actions, plant synthetic claims,
// open regulator forms, and read the form structure back — all without UI
// clicks.
//
// The page also holds the user's real settings in memory while a run is in
// progress and writes them back on unload/restore. The real settings never
// leave the user's machine.

(function () {
    "use strict";

    var SYNTHETIC_IDENTITY = {
        title: "Mr",
        firstName: "Test",
        surname: "Person",
        address: "1 Test Street",
        city: "Testchester",
        county: "Testshire",
        postcode: "TE1 1ST",
        phonenumber: "+44 7700 900000",
        email: "test@example.com"
        // Country is intentionally NOT overridden — the harness sets it per
        // authority since it gates which regulators appear in the UI.
    };

    var _realSettingsBackup = null;
    var _lastAction = null;

    function bg(message) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage(message, function (response) {
                void chrome.runtime.lastError;
                resolve(response);
            });
        });
    }

    function setStatus(text, kind) {
        var p = document.getElementById("aut-status-pill");
        if (!p) return;
        p.className = "fb-status-pill" + (kind ? " " + kind : "");
        p.innerText = text;
    }

    function note(action) {
        _lastAction = action + " @ " + new Date().toISOString();
        var el = document.getElementById("aut-last-action");
        if (el) el.innerText = _lastAction;
    }

    function refreshIdentityBadges() {
        var idMode = document.getElementById("aut-identity-mode");
        var bk = document.getElementById("aut-backup-state");
        var restoreBtn = document.getElementById("aut-restore");
        if (idMode) idMode.innerText = _realSettingsBackup ? "synthetic (backup held)" : "real (untouched)";
        if (bk) bk.innerText = _realSettingsBackup ? Object.keys(_realSettingsBackup).length + " keys held in memory" : "none";
        if (restoreBtn) restoreBtn.style.display = _realSettingsBackup ? "inline-block" : "none";
    }

    // ----- Public API --------------------------------------------------------

    var FBControl = {
        SYNTHETIC_IDENTITY: SYNTHETIC_IDENTITY,

        getExtensionId: function () {
            return chrome.runtime.id;
        },

        getStatus: async function () {
            var state = await bg({ type: "getState" });
            var settings = await bg({ type: "getSettings" });
            return {
                extensionId: chrome.runtime.id,
                identityMode: _realSettingsBackup ? "synthetic" : "real",
                backupKeyCount: _realSettingsBackup ? Object.keys(_realSettingsBackup).length : 0,
                lastAction: _lastAction,
                state: state,
                settings: settings
            };
        },

        listAuthorities: function () {
            if (typeof Authorities !== "object") return [];
            var out = [];
            for (var k in Authorities) {
                var a = Authorities[k];
                out.push({
                    key: k,
                    Country: a.Country || null,
                    Name: a.Name || null,
                    broken: !!a.broken,
                    brokenReason: a.brokenReason || null,
                    hasComposeComplaint: typeof a.ComposeComplaint === "function",
                    hasAutoFillForm: typeof a.AutoFillForm === "function"
                });
            }
            return out;
        },

        captureRealSettings: async function () {
            var settings = await bg({ type: "getSettings" });
            _realSettingsBackup = settings || {};
            note("captureRealSettings (" + Object.keys(_realSettingsBackup).length + " keys)");
            refreshIdentityBadges();
            return Object.keys(_realSettingsBackup).length;
        },

        setSyntheticIdentity: async function (overrides) {
            if (!_realSettingsBackup) {
                throw new Error("Refusing to write synthetic identity without a backup. Call captureRealSettings() first.");
            }
            var payload = Object.assign({}, SYNTHETIC_IDENTITY, overrides || {});
            await bg({ type: "setSyntheticSettings", settings: payload });
            note("setSyntheticIdentity");
            setStatus("Synthetic identity active", "fb-ai-downloadable");
            refreshIdentityBadges();
            return payload;
        },

        restoreRealSettings: async function () {
            if (!_realSettingsBackup) {
                note("restoreRealSettings (no backup to restore)");
                return { restored: false, reason: "no-backup" };
            }
            var backup = _realSettingsBackup;
            var resp = await bg({ type: "restoreSettings", backup: backup, clearFirst: true });
            _realSettingsBackup = null;
            note("restoreRealSettings (" + Object.keys(backup).length + " keys)");
            setStatus("Idle");
            refreshIdentityBadges();
            return { restored: true, response: resp };
        },

        setCountry: async function (country) {
            // The audit harness sets this per-authority so the right
            // regulators appear in the Review listing.
            await bg({ type: "setSyntheticSettings", settings: { Country: country } });
            note("setCountry(" + country + ")");
            return true;
        },

        seedClaimGroup: async function (opts) {
            opts = opts || {};
            var company = opts.company || "Quantum Wellness Ltd";
            var url = opts.url || "https://www.example-snake-oil.com/";
            var claims = opts.claims && opts.claims.length ? opts.claims : [
                { quote: "Our remedies cure cancer.", backgroundInfo: "Unsupported efficacy claim for a serious condition." },
                { quote: "Helped my child with severe anger problems.", backgroundInfo: "Testimonial claiming efficacy for a psychological condition." },
                { quote: "Restores the body's natural balance and energy flow.", backgroundInfo: "Vague mechanism claim with no evidence base." }
            ];

            await bg({ type: "clearCapture" });
            await bg({ type: "init" });

            // Plant each claim via the same addClaim path the content script
            // uses. dedupByQuote off so we can re-seed exactly the same data.
            var ids = [];
            for (var i = 0; i < claims.length; i++) {
                var c = claims[i];
                var r = await bg({
                    type: "addClaim",
                    selectedText: c.quote,
                    url: c.url || url,
                    textRangeToStringFormatText: c.quote,
                    instanceSelected: 1,
                    backgroundInfo: c.backgroundInfo || "",
                    dedupByQuote: false
                });
                if (r && r.id) ids.push(r.id);
            }

            // Set the company name as if the AI had identified it.
            await bg({ type: "setOrgNameIfEmpty", name: company });

            note("seedClaimGroup(" + claims.length + " claims, company=" + JSON.stringify(company) + ")");
            return { claimIds: ids, company: company };
        },

        composeFor: async function (authorityKey) {
            // Listen for tab creation and update events while triggering the
            // composeComplaint message. Returns the new (or navigated) tab id
            // and final URL so the harness can read its form.
            var resolvedTabId = null;
            var resolvedUrl = null;
            var startedAt = Date.now();
            var beforeTabs = await new Promise(function (resolve) {
                chrome.tabs.query({}, function (tabs) { resolve(new Set(tabs.map(function (t) { return t.id; }))); });
            });

            note("composeFor(" + authorityKey + ")");
            var result = await bg({ type: "composeComplaint", key: authorityKey });
            if (result && result.error) {
                return { error: result.error };
            }

            // Poll for ~15 s for a new tab on the regulator's URL, or for an
            // existing tab to be navigated. ComposeComplaint can do either.
            for (var attempt = 0; attempt < 30; attempt++) {
                await new Promise(function (r) { setTimeout(r, 500); });
                var tabs = await new Promise(function (resolve) {
                    chrome.tabs.query({}, function (ts) { resolve(ts); });
                });
                // Prefer a brand-new tab.
                var newTabs = tabs.filter(function (t) { return !beforeTabs.has(t.id); });
                var picked = null;
                for (var i = 0; i < newTabs.length; i++) {
                    if (newTabs[i].url && /^https?:/.test(newTabs[i].url) && newTabs[i].status === "complete") {
                        picked = newTabs[i];
                        break;
                    }
                }
                // Fall back to any tab whose URL changed AND looks like a
                // regulator form (not the extension itself).
                if (!picked) {
                    for (var j = 0; j < tabs.length; j++) {
                        var t = tabs[j];
                        if (!t.url || !/^https?:/.test(t.url)) continue;
                        if (t.url.indexOf("chrome-extension:") === 0) continue;
                        if (t.lastAccessed && t.lastAccessed > startedAt && t.status === "complete") {
                            picked = t;
                            break;
                        }
                    }
                }
                if (picked) {
                    resolvedTabId = picked.id;
                    resolvedUrl = picked.url;
                    break;
                }
            }
            // 6 s settling so AI/Wix-style hydration completes (matches the
            // spider's window).
            await new Promise(function (r) { setTimeout(r, 6000); });
            return { tabId: resolvedTabId, url: resolvedUrl };
        },

        snapshotForm: async function (tabId) {
            if (typeof tabId !== "number") throw new Error("snapshotForm requires a tabId");
            var resp = await bg({ type: "snapshotForm", tabId: tabId });
            note("snapshotForm(tab=" + tabId + ")");
            return resp;
        },

        readFieldValues: async function (tabId, names) {
            // Read the .value of each named field via scripting.executeScript.
            // Used to confirm a fill actually landed.
            if (typeof tabId !== "number") throw new Error("readFieldValues requires a tabId");
            if (!Array.isArray(names)) throw new Error("readFieldValues requires names[]");
            var results = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: function (fieldNames) {
                    var out = {};
                    for (var i = 0; i < fieldNames.length; i++) {
                        var n = fieldNames[i];
                        var els = document.getElementsByName(n);
                        if (els.length === 0) els = document.getElementById(n) ? [document.getElementById(n)] : [];
                        if (els.length === 0) { out[n] = null; continue; }
                        var el = els[0];
                        if (el.type === "checkbox" || el.type === "radio") out[n] = !!el.checked;
                        else out[n] = el.value || "";
                    }
                    return out;
                },
                args: [names]
            });
            // Merge per-frame results, last-non-null wins.
            var merged = {};
            for (var i = 0; i < results.length; i++) {
                var r = results[i] && results[i].result;
                if (!r) continue;
                for (var k in r) {
                    if (r[k] !== null && r[k] !== "") merged[k] = r[k];
                    else if (!(k in merged)) merged[k] = r[k];
                }
            }
            return merged;
        },

        endAndClear: async function () {
            await bg({ type: "endCapture" });
            await bg({ type: "clearCapture" });
            note("endAndClear");
            return true;
        }
    };

    window.FBControl = FBControl;

    // ----- Page UI wiring ----------------------------------------------------

    document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("aut-ext-id").innerText = chrome.runtime.id;
        document.getElementById("aut-synthetic-dump").innerText = JSON.stringify(SYNTHETIC_IDENTITY, null, 2);
        refreshIdentityBadges();

        document.getElementById("aut-restore").addEventListener("click", async function () {
            var r = await FBControl.restoreRealSettings();
            alert(r.restored ? "Real settings restored." : "Nothing to restore (no backup in memory).");
        });

        document.getElementById("aut-show-state").addEventListener("click", async function () {
            var s = await FBControl.getStatus();
            var dump = document.getElementById("aut-state-dump");
            dump.style.display = "block";
            dump.innerText = JSON.stringify(s, null, 2);
        });

        // Safety net: if the page is closing and we still have a backup of
        // real settings, write them back synchronously via sendMessage. The
        // browser may not wait for the response, but the message goes out.
        window.addEventListener("beforeunload", function () {
            if (_realSettingsBackup) {
                try {
                    chrome.runtime.sendMessage({
                        type: "restoreSettings",
                        backup: _realSettingsBackup,
                        clearFirst: true
                    });
                } catch (e) { /* nothing more we can do at this point */ }
            }
        });
    });
})();
