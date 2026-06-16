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
    ShowTabsForSelectedCountry(true);
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

document.addEventListener('DOMContentLoaded', function () {
    Init();
    document.getElementById("btnClearLocalStorage").addEventListener('click', async function () {
        if (confirm('Are you sure? This will delete all of your settings and reset your templates.')) {
            await FBStorage.clearLocal();
            location.reload();
        }
        return false;
    });
});
