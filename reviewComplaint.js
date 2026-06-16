// Review page. All state comes via runtime messages to the service worker.

var CurrentClaimGroup = null;
var CurrentCountry = "UK";

async function UpdateBackgroundInfo(claimId, info) {
    await sendBg({ type: "updateBackgroundInfo", claimId: claimId, info: info });
}

async function DeleteClaim(claimId) {
    await sendBg({ type: "deleteClaim", claimId: claimId });
    await refresh();
}

async function UpdateOrgName(name) {
    await sendBg({ type: "updateOrgName", name: name });
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function DisplayClaimsForm() {
    var el = document.getElementById("ClaimEdit");

    var s = "";
    var claims = (CurrentClaimGroup && CurrentClaimGroup.claims) || [];

    if (CurrentClaimGroup) {
        document.getElementById("organisationname").value = CurrentClaimGroup._CompanyName || "";
    }

    if (claims.length > 0) {
        s += "<h2 style='margin-top:24px;'>" + claims.length + " claim" + (claims.length === 1 ? "" : "s") + " captured</h2>";
        for (var i = 0; i < claims.length; i++) {
            var claim = claims[i];
            s += "<div class='claim'>";
            s += "<div style='display:flex; align-items:baseline; justify-content:space-between; gap:12px;'>";
            s += "<h3>Claim #" + (i + 1) + "</h3>";
            s += "<a id='deleteClaim_" + escapeHtml(claim.id) + "' data-claim-id='" + escapeHtml(claim.id) + "' href='#'>Remove</a>";
            s += "</div>";
            s += "<p class='muted'>From <a target='_blank' rel='noopener' href='" + escapeHtml(claim.url) + "'>" + escapeHtml(claim.url) + "</a></p>";
            s += "<blockquote id='claimText_" + escapeHtml(claim.id) + "'></blockquote>";
            s += "<label for='backgroundInfo_" + escapeHtml(claim.id) + "'>Why is this claim misleading? (Optional background info, included with the complaint.)</label>";
            s += "<textarea id='backgroundInfo_" + escapeHtml(claim.id) + "' data-claim-id='" + escapeHtml(claim.id) + "' placeholder='e.g. I know of no evidence supporting this claim.'></textarea>";
            s += "</div>";
        }
    } else {
        s += "<div class='fb-empty'>You haven't captured any claims yet. Click the FishBarrel icon and choose <strong>Capture new claims</strong>, then highlight text on any page.</div>";
    }

    el.innerHTML = s;

    if (CurrentClaimGroup && CurrentClaimGroup.claims) {
        var claims = CurrentClaimGroup.claims;
        for (var i = 0; i < claims.length; i++) {
            var claim = claims[i];
            document.getElementById("claimText_" + claim.id).innerText = '"' + claim.claimText + '"';
            document.getElementById("backgroundInfo_" + claim.id).value = claim.backgroundInfo || "";
        }
    }

    document.getElementById("organisationname").addEventListener('keyup', function () { UpdateOrgName(this.value); });
    document.getElementById("organisationname").addEventListener('change', function () { UpdateOrgName(this.value); });

    if (CurrentClaimGroup && CurrentClaimGroup.claims) {
        var claims = CurrentClaimGroup.claims;
        for (var i = 0; i < claims.length; i++) {
            var claim = claims[i];
            document.getElementById('deleteClaim_' + claim.id).addEventListener("click", function (event) {
                event.preventDefault();
                DeleteClaim(this.getAttribute("data-claim-id"));
            });
            document.getElementById('backgroundInfo_' + claim.id).addEventListener("keyup", function () {
                UpdateBackgroundInfo(this.getAttribute("data-claim-id"), this.value);
            });
            document.getElementById('backgroundInfo_' + claim.id).addEventListener("change", function () {
                UpdateBackgroundInfo(this.getAttribute("data-claim-id"), this.value);
            });
        }
    }

    var bHtml = "";
    for (var key in Authorities) {
        if (Authorities[key].Country == CurrentCountry) {
            bHtml += "<button id='ComposeComplaint_" + escapeHtml(key) + "' data-authority-key='" + escapeHtml(key) + "'>" + escapeHtml(Authorities[key].Name) + "</button>";
        }
    }
    document.getElementById("StartComplaintButtons").innerHTML = bHtml;

    for (var key in Authorities) {
        if (Authorities[key].Country == CurrentCountry) {
            document.getElementById("ComposeComplaint_" + key).addEventListener('click', function () {
                ComposeComplaint(this.getAttribute("data-authority-key"));
            });
        }
    }
}

async function ComposeComplaint(key) {
    var auth = Authorities[key];
    if (!auth) return;
    var claims = (CurrentClaimGroup && CurrentClaimGroup.claims) || [];

    if (auth.ForceJustification == true) {
        for (var i = 0; i < claims.length; i++) {
            if (!claims[i].backgroundInfo) {
                alert("The ASA now requires that you give a justification for each claim. Please fill out the background info below for each claim.");
                return;
            }
        }
    }

    if (key == "ASA") {
        alert("Due to problems with the ASA, you may need to click 'Next' to move between some of the form pages.");
    }
    if (key == "CanadianASC") {
        alert("Due to a problem with the new ASC complaint form, you will need to click through the 'next' buttons on the form.");
    }

    var result = await sendBg({ type: "composeComplaint", key: key });
    if (result && result.error == "settings-incomplete") {
        alert("You must complete the options page before submitting a complaint. Right-click on the FishBarrel icon and click options.");
    } else if (result && result.error == "no-template") {
        alert("Please go to the settings page to\r\ngenerate a template for this authority.");
    }
}

async function refresh() {
    var state = await sendBg({ type: "getState" });
    CurrentClaimGroup = state ? state.claimGroup : null;

    var local = await FBStorage.getLocal(["Country"]);
    CurrentCountry = local.Country || "UK";

    DisplayClaimsForm();
}

document.addEventListener('DOMContentLoaded', function () { refresh(); });
