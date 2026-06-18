// Settings page: stores everything in chrome.storage.local.

var SettingsCache = {};
var DefaultsCache = {};

async function save_options() {
    var form = document.forms[0];
    var batch = {};
    for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        var pair = readElement(el);
        if (pair) batch[pair.name] = pair.value;
    }
    Object.assign(SettingsCache, batch);
    await FBStorage.setLocal(batch);
}

function readElement(el) {
    if (!el.id && !el.name) return null;
    var name = el.id;
    var value = el.value;

    if (el.type == "radio") {
        if (!el.checked) return null;
        name = el.name;
        value = el.value;
    } else if (el.type == "select-one") {
        if (el.selectedIndex < 0) return null;
        value = el.options[el.selectedIndex].text;
    } else if (el.type == "checkbox") {
        value = el.checked ? "1" : "0";
    }

    if (!name) return null;
    return { name: name, value: value };
}

async function SaveElement(el) {
    var pair = readElement(el);
    if (!pair) return;
    SettingsCache[pair.name] = pair.value;
    var update = {};
    update[pair.name] = pair.value;
    await FBStorage.setLocal(update);
}

async function restore_options() {
    SettingsCache = await FBStorage.getLocal(null);

    var form = document.forms[0];
    for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        var name = el.id;
        var stored;

        if (el.type == "select-one") {
            stored = SettingsCache[name];
            if (stored != null) {
                for (var c = 0; c < el.options.length; c++) {
                    if (el.options[c].text == stored) el.selectedIndex = c;
                }
            }
        } else if (el.type == "checkbox") {
            el.checked = SettingsCache[name] == "1";
        } else if (el.type == "radio") {
            el.checked = SettingsCache[el.name] == el.value;
        } else {
            if (SettingsCache[name] != null) el.value = SettingsCache[name];
        }

        el.addEventListener("change", async function () {
            await SaveElement(this);
            GeneratePreviews();
            if (this.id && this.id.indexOf("Country_") == 0) ShowTabsForSelectedCountry(true);
        });
        el.addEventListener("keyup", async function () {
            await SaveElement(this);
            GeneratePreviews();
        });
    }

    // Persist any defaults that landed on disk for the first time.
    await save_options();
    GeneratePreviews();
}

function GeneratePreview(prevType) {
    var demoClaims = ClaimGroup.DemoClaim();
    var prev = demoClaims.GenerateComplaintText(prevType, SettingsCache);
    var el = document.getElementById("ComplaintTemplate." + prevType + ".Preview");
    if (el) el.value = prev == null ? "" : prev;
}

function GeneratePreviews() {
    var currentCountry = SettingsCache["Country"];
    for (var key in Authorities) {
        var fieldsetId = "Template.Authority." + key;
        var fieldSetEl = document.getElementById(fieldsetId);
        var authorityInCurrentCountry = Authorities[key].Country == currentCountry;

        if (fieldSetEl) {
            fieldSetEl.style.display = authorityInCurrentCountry ? "block" : "none";
        }

        var tabEl = document.getElementById('TabLi_' + key);
        if (tabEl) {
            tabEl.style.display = authorityInCurrentCountry ? "inline" : "none";
        }

        GeneratePreview(key);
    }
}

function ShowTabsForSelectedCountry(selectFirst) {
    var firstTabSelected = false;
    var currentCountry = SettingsCache["Country"];
    for (var key in Authorities) {
        var authorityInCurrentCountry = Authorities[key].Country == currentCountry;
        if ((!firstTabSelected) && selectFirst && authorityInCurrentCountry) {
            var link = document.getElementById("TabLi_a_" + key);
            if (link) {
                ShowTab(link, "Tab_" + key);
                firstTabSelected = true;
            }
        }
    }
}

function ShowTab(linkClicked, key) {
    var content = document.getElementById(key);
    if (!content) return;
    content.style.display = "block";

    var ul = linkClicked;
    var li = linkClicked;
    while (ul && ul.tagName != "UL") ul = ul.parentNode;
    while (li && li.tagName != "LI") li = li.parentNode;
    if (!ul || !li) return;

    for (var i = 0; i < ul.children.length; i++) {
        if (ul.children[i] != li) ul.children[i].className = "";
    }
    li.className = "selected";

    var contentHolder = content.parentNode;
    for (var i = 0; i < contentHolder.children.length; i++) {
        var el = contentHolder.children[i];
        if (el.className == "TabContent" && el != content) el.style.display = "none";
    }
}

async function Init() {
    // Cache the in-DOM default template text BEFORE we restore from storage,
    // so the Reset Template buttons can revert to it.
    var form = document.forms[0];
    for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (el.id) DefaultsCache[el.id] = el.value;
    }

    var tabUL = document.getElementById("TabUL");
    var s = "";
    for (var key in Authorities) {
        s += '<li id="TabLi_' + key + '"><a id="TabLi_a_' + key + '" data-authority-key="' + key + '" href="#">' + Authorities[key].Name + '</a></li>';
    }
    tabUL.innerHTML = s;

    for (var key in Authorities) {
        (function (k) {
            var link = document.getElementById("TabLi_a_" + k);
            if (link) {
                link.addEventListener('click', function (event) {
                    ShowTab(this, "Tab_" + k);
                    event.preventDefault();
                });
            }
            var reset = document.getElementById("ResetTemplate_" + k);
            if (reset) {
                reset.href = "#";
                reset.addEventListener('click', async function (event) {
                    await ResetTemplate(k);
                    event.preventDefault();
                });
            }
        })(key);
    }

    await restore_options();
    await hideEmptyCountries();
    ShowTabsForSelectedCountry(true);
}

// Hide Country radios for any country whose every authority is marked
// broken. If the user's currently saved country is one of those, switch
// them to the first still-active country and persist it. Keyed off
// authority.broken so this self-updates as authorities get rewired.
async function hideEmptyCountries() {
    var working = {};
    for (var k in Authorities) {
        var a = Authorities[k];
        if (a.Country && !a.broken) working[a.Country] = true;
    }
    var workingList = Object.keys(working).sort();

    var countryInputs = document.querySelectorAll('input[name="Country"]');
    var firstAvailable = null;
    for (var i = 0; i < countryInputs.length; i++) {
        var input = countryInputs[i];
        var lbl = input.closest('label') || input.parentElement;
        if (working[input.value]) {
            if (!firstAvailable) firstAvailable = input.value;
            if (lbl) lbl.style.display = "";
        } else {
            if (lbl) lbl.style.display = "none";
        }
    }

    // If the saved country no longer has any working authority, move the
    // user to the first available country and save.
    var current = SettingsCache["Country"];
    if (current && !working[current] && firstAvailable) {
        SettingsCache["Country"] = firstAvailable;
        await FBStorage.setLocal({ Country: firstAvailable });
        var radio = document.querySelector('input[name="Country"][value="' + firstAvailable.replace(/"/g, '\\"') + '"]');
        if (radio) radio.checked = true;
    }
}

async function ResetTemplate(templateType) {
    var batch = {};
    for (var i = 0; i < document.forms[0].elements.length; i++) {
        var el = document.forms[0].elements[i];
        if (el.id && el.id.indexOf("ComplaintTemplate." + templateType) == 0) {
            var def = DefaultsCache[el.id] != null ? DefaultsCache[el.id] : "";
            el.value = def;
            batch[el.id] = def;
        }
    }
    Object.assign(SettingsCache, batch);
    await FBStorage.setLocal(batch);
    GeneratePreviews();
}

// ----- AI auto-detect card ---------------------------------------------------

async function refreshAiStatus() {
    var pill = document.getElementById("aiStatusPill");
    var dlBtn = document.getElementById("aiDownload");
    var help = document.getElementById("aiUnavailableHelp");
    if (!pill) return;

    pill.className = "fb-status-pill";
    pill.innerText = "Checking…";
    dlBtn.style.display = "none";
    help.style.display = "none";

    if (typeof LanguageModel === "undefined") {
        pill.classList.add("fb-ai-unavailable");
        pill.innerText = "Unavailable";
        help.style.display = "block";
        return;
    }

    var status;
    try {
        status = await LanguageModel.availability({
            expectedInputs: [{ type: "text", languages: ["en"] }],
            expectedOutputs: [{ type: "text", languages: ["en"] }]
        });
    } catch (e) {
        status = "unavailable";
    }

    if (status === "available") {
        pill.classList.add("fb-ai-ready");
        pill.innerText = "Ready";
    } else if (status === "downloadable") {
        pill.classList.add("fb-ai-downloadable");
        pill.innerText = "Downloadable";
        dlBtn.style.display = "inline-block";
    } else if (status === "downloading") {
        pill.classList.add("fb-ai-downloading");
        pill.innerText = "Downloading…";
    } else {
        pill.classList.add("fb-ai-unavailable");
        pill.innerText = "Unavailable";
        help.style.display = "block";
    }
}

async function triggerModelDownload() {
    if (typeof LanguageModel === "undefined") return;
    var pill = document.getElementById("aiStatusPill");
    pill.className = "fb-status-pill fb-ai-downloading";
    pill.innerText = "Downloading…";
    try {
        var session = await LanguageModel.create({
            expectedInputs: [{ type: "text", languages: ["en"] }],
            expectedOutputs: [{ type: "text", languages: ["en"] }],
            monitor: function (m) {
                m.addEventListener("downloadprogress", function (e) {
                    var pct = Math.round((e.loaded || 0) * 100);
                    pill.innerText = "Downloading… " + pct + "%";
                });
            }
        });
        try { session.destroy(); } catch (e) { /* ignore */ }
    } catch (e) {
        console.log("[FishBarrel] model download failed:", e);
    }
    refreshAiStatus();
}

function applyDefaultPromptIfEmpty() {
    var ta = document.getElementById("aiPromptTemplate");
    if (!ta) return;
    if (!ta.value && typeof FishBarrelAI !== "undefined") {
        ta.value = FishBarrelAI.DEFAULT_PROMPT_TEMPLATE;
    }
}

async function initAiCard() {
    applyDefaultPromptIfEmpty();
    refreshAiStatus();

    document.getElementById("aiCheckStatus").addEventListener("click", function (e) {
        e.preventDefault();
        refreshAiStatus();
    });
    document.getElementById("aiDownload").addEventListener("click", function (e) {
        e.preventDefault();
        triggerModelDownload();
    });
    document.getElementById("aiResetTemplate").addEventListener("click", async function (e) {
        e.preventDefault();
        if (typeof FishBarrelAI === "undefined") return;
        var ta = document.getElementById("aiPromptTemplate");
        ta.value = FishBarrelAI.DEFAULT_PROMPT_TEMPLATE;
        SettingsCache["aiPromptTemplate"] = ta.value;
        await FBStorage.setLocal({ aiPromptTemplate: ta.value });
    });
}

document.addEventListener('DOMContentLoaded', async function () {
    await Init();
    initAiCard();
    document.getElementById("btnClearLocalStorage").addEventListener('click', async function () {
        if (confirm('Are you sure? This will delete all of your settings and reset your templates.')) {
            await FBStorage.clearLocal();
            location.reload();
        }
        return false;
    });
});
