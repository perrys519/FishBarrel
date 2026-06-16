// Shared data model and helpers for FishBarrel.
// Loaded by background.js (importScripts) and by popup.html, settings.html,
// reviewComplaint.html and TextShortener.html as a classic <script>.

function FalseClaim() {
    this.uploaded = false;
}

function ClaimGroup() {
    this.claims = [];
    this.id = RandomStr(10);
    this._CompanyName = "";
}

ClaimGroup.Current = null;
ClaimGroup.IsCollecting = false;

ClaimGroup.prototype.GetById = function (id) {
    for (var i = 0; i < this.claims.length; i++) {
        if (this.claims[i].id == id) return this.claims[i];
    }
};

ClaimGroup.prototype.CompanyName = function (suppressPrompt) {
    if (this._CompanyName != "") return this._CompanyName;
    if (suppressPrompt == true) return this._CompanyName;

    if (typeof prompt === "function") {
        this._CompanyName = prompt("What is the name of this organisation?") || "";
    }
    return this._CompanyName;
};

ClaimGroup.prototype.WebsiteUrl = function () {
    if (this.claims.length > 0) {
        this._WebsiteUrl = this.claims[0].url;
    } else {
        return "";
    }

    var firstSlash = this._WebsiteUrl.indexOf("/", 8);
    if (firstSlash == -1) return "";
    return this._WebsiteUrl.substring(0, firstSlash);
};

// Re-wraps a plain object (deserialised from chrome.storage.session) as a ClaimGroup
// so the prototype methods are available again.
ClaimGroup.Rehydrate = function (plain) {
    if (!plain) return null;
    var g = Object.assign(new ClaimGroup(), plain);
    g.claims = (plain.claims || []).map(function (c) {
        return Object.assign(new FalseClaim(), c);
    });
    return g;
};

ClaimGroup.prototype.AddClaim = function (claimText, url, textRangeToStringFormatText, instanceSelected, backgroundInfo, id, uploaded) {
    var tmp = new FalseClaim();
    tmp.claimText = claimText;
    tmp.url = url;
    tmp.textRangeToStringFormatText = textRangeToStringFormatText;
    tmp.instanceSelected = instanceSelected;
    tmp.id = id != null ? id : RandomStr(10);
    tmp.uploaded = !!uploaded;
    tmp.backgroundInfo = backgroundInfo || "";

    if (!this.claims) this.claims = [];
    this.claims.push(tmp);
};

ClaimGroup.prototype.DeleteClaim = function (claimId) {
    for (var i = 0; i < this.claims.length; i++) {
        if (this.claims[i].id == claimId) {
            this.claims.splice(i, 1);
            return;
        }
    }
};

// Generate the complaint body text from a template stored in chrome.storage.local.
// `settings` is a flat object whose keys come from chrome.storage.local.
ClaimGroup.prototype.GenerateComplaintText = function (claimType, settings) {
    var templates = settings || {};

    var header = templates["ComplaintTemplate." + claimType + ".Header"];
    var claimTpl = templates["ComplaintTemplate." + claimType + ".Claim"];
    var footer = templates["ComplaintTemplate." + claimType + ".Footer"];

    if (claimTpl == null) {
        return null;
    }

    var prev = header || "";

    for (var i = 0; i < this.claims.length; i++) {
        var c = this.claims[i];
        var rendered = claimTpl
            .replace(/\<index\>/gi, "" + (i + 1))
            .replace(/\<url\>/gi, c.url || "")
            .replace(/\<claim\>/gi, c.claimText || "")
            .replace(/\<background\>/gi, c.backgroundInfo || "");
        prev += rendered;
    }

    prev += footer || "";

    var address = ""
        + "\r\n" + (settings["address"] || "")
        + "\r\n" + (settings["city"] || "")
        + "\r\n" + (settings["county"] || "")
        + "\r\n" + (settings["postcode"] || "");

    var name = (settings["firstName"] || "") + " " + (settings["surname"] || "");

    prev = prev
        .replace(/\<address\>/gi, address)
        .replace(/\<name\>/gi, name)
        .replace(/\<phone\>/gi, settings["phonenumber"] || "")
        .replace(/\<email\>/gi, settings["email"] || "")
        .replace(/\<domain\>/gi, this.WebsiteUrl())
        .replace(/\<company\>/gi, this.CompanyName(true));

    // Screenshots were a server-hosted feature; the server is gone, so any
    // <if_screenshots>...</if_screenshots> block always renders empty.
    prev = prev.replace(/\<if_screenshots\>([^]*?)\<\/if_screenshots\>/gi, "");
    prev = prev.replace(/\<screenshots\>/gi, "");

    return prev;
};

ClaimGroup._DemoClaim = null;
ClaimGroup.DemoClaim = function () {
    if (ClaimGroup._DemoClaim == null) {
        var d = new ClaimGroup();
        d._CompanyName = "Quantum Holistic Healing Limited";
        d.AddClaim("Our magic beans will cure you of AIDS.", "http://www.my-local-quack.com/magic-beans", "", 1, "I know of no evidence of this product's efficacy in the treatment of AIDS.");
        d.AddClaim("Has been demonstrated to protect you from harmful WiFi radiation.", "http://www.my-local-quack.com/wifi-protection", "", 1, "");
        d.AddClaim("There really is good evidence to show this is effective, certainly more than a jot.", "http://www.my-local-quack.com/not-a-jot", "", 1, "The evidence they are referring to largely consists of anecdotes, and one paper that was later withdrawn.");
        ClaimGroup._DemoClaim = d;
    }
    return ClaimGroup._DemoClaim;
};

function RandomStr(NumberOfChars) {
    var s = "";
    for (var i = 0; i < NumberOfChars; i++) {
        var c = Math.floor(Math.random() * 62 + 48);
        if (c > 57) c += 7;
        if (c > 90) c += 6;
        s += String.fromCharCode(c);
    }
    return s;
}

// Promise wrappers around chrome.storage so UI pages can use await.
var FBStorage = {
    getLocal: function (keys) {
        return new Promise(function (resolve) {
            chrome.storage.local.get(keys, function (items) { resolve(items || {}); });
        });
    },
    setLocal: function (items) {
        return new Promise(function (resolve) {
            chrome.storage.local.set(items, function () { resolve(); });
        });
    },
    removeLocal: function (keys) {
        return new Promise(function (resolve) {
            chrome.storage.local.remove(keys, function () { resolve(); });
        });
    },
    clearLocal: function () {
        return new Promise(function (resolve) {
            chrome.storage.local.clear(function () { resolve(); });
        });
    }
};

// Promise wrapper around runtime.sendMessage so callers can use await.
function sendBg(message) {
    return new Promise(function (resolve) {
        chrome.runtime.sendMessage(message, function (response) {
            // Ignore runtime.lastError; absent listeners just resolve undefined.
            void chrome.runtime.lastError;
            resolve(response);
        });
    });
}
