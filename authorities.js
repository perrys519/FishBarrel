// Authority handlers. Loaded in BOTH the service worker (via importScripts) and
// every page (as a content script). ComposeComplaint runs in the service worker
// to open a tab on the regulator's form. AutoFillForm runs in the page context
// to populate the form when it loads.

var Authorities = {};

// Helper used by every ComposeComplaint: navigate the active tab to the given
// regulator URL. Used from the service worker.
function navigateActiveTab(url) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
            chrome.tabs.update(tabs[0].id, { url: url });
        } else {
            chrome.tabs.create({ url: url });
        }
    });
}

// Helper used by AutoFillForm callbacks to fetch the composed body + settings.
// Wraps chrome.runtime.sendMessage in a familiar callback shape.
function askIfComplaintReady(authority, callback) {
    chrome.runtime.sendMessage({ type: "getComplaintReady", authority: authority }, function (response) {
        if (chrome.runtime.lastError) return; // background not listening; nothing to do.
        if (response) callback(response);
    });
}

// Mark an authority as out-of-date. Replaces its ComposeComplaint with a stub
// that opens the regulator's main / help page so the user can find the right
// complaint route manually, and leaves AutoFillForm as a no-op so an
// accidentally-loaded match doesn't try to fill anything. The Review page UI
// reads .broken to render the button as disabled with an "(out of date)"
// suffix.
//
// Stubs run in the service-worker context (no DOM, no alert), so the entire
// user feedback is the new tab opening on the help URL. Pair with the
// reviewComplaint UI's broken-button styling so the user isn't surprised.
function markBroken(authority, reason, helpUrl) {
    authority.broken = true;
    authority.brokenReason = reason;
    authority.helpUrl = helpUrl;
    authority.ComposeComplaint = function () {
        try { chrome.tabs.create({ url: helpUrl }); } catch (e) { /* ignore */ }
    };
    authority.AutoFillForm = function () { /* no longer wired */ };
}

/*
##################################################################
VZHH / Verbraucherzentrale Hamburg
##################################################################
*/
var VZHHAuth = {};
VZHHAuth.Key = "VZHH";
VZHHAuth.Country = "Germany";
VZHHAuth.Name = "Verbraucherzentrale Hamburg";

VZHHAuth.ComposeComplaint = function () {
    var company = ClaimGroup.Current ? ClaimGroup.Current.CompanyName(true) : "";
    var to = "<managementboy@gmail.com>;<c.snijders@yahoo.de>;<eugen.wintersberger@gmail.com>";
    var subject = "Verstoss gegen das Heilmittelwerbegesetz durch " + company;
    var url = "https://mail.google.com/mail/h/?v=b&cs=wh&f=1"
        + "&to=" + encodeURIComponent(to)
        + "&subject=" + encodeURIComponent(subject);
    VZHHAuth.LastUrl = url;
    chrome.tabs.create({ url: url });
};

VZHHAuth.AutoFillForm = function () {
    if ((window.location.href.indexOf("managementboy@gmail.com") != -1) && (window.location.href.indexOf("https://mail.google.com/") == 0)) {
        askIfComplaintReady("VZHH", function (response) {
            FishBarrel.FillFormElement(1, 'body', response.body);
            if (document.forms[1] && document.forms[1].elements['nvp_bu_send']) {
                var btns = document.forms[1].elements['nvp_bu_send'];
                if (btns[0]) btns[0].addEventListener('click', function () { FishBarrel.ComplaintSent("VZHH"); }, false);
                if (btns[1]) btns[1].addEventListener('click', function () { FishBarrel.ComplaintSent("VZHH"); }, false);
            }
        });
    }
};
Authorities[VZHHAuth.Key] = VZHHAuth;

// CNHC handler removed: its complaint form was hosted on the (now defunct)
// FishBarrel server, not on the CNHC's own website, so there is nothing to
// link to. A future revision could add a handler pointing at whatever the
// CNHC currently publishes as a complaints route.

/*
##################################################################
SRC / Stichting Reclame Code (Netherlands)
##################################################################
*/
var SRCAuth = {};
SRCAuth.Key = "SRC";
SRCAuth.Country = "Netherlands";
SRCAuth.Name = "Stichting Reclame Code";

SRCAuth.ComposeComplaint = function () {
    navigateActiveTab("http://www.reclamecode.nl/consument/default.asp?paginaID=73");
};

SRCAuth.AutoFillForm = function () {
    var page2Url = "http://www.reclamecode.nl/klachten_mod.asp";
    if (page2Url == window.location.href) {
        askIfComplaintReady("SRC", function () {
            if (document.forms[0]) {
                document.forms[0].addEventListener('submit', function () { FishBarrel.ComplaintSent("SRC"); }, false);
            }
        });
        return;
    }

    var url = "http://www.reclamecode.nl/consument/default.asp?paginaID=73";
    if (url == window.location.href) {
        askIfComplaintReady("SRC", function (response) {
            var settings = response.settings;
            FishBarrel.FillElement("particulier", true);

            if (settings.title == "Mr") {
                FishBarrel.FillRadioButton(0, "dhrmevr", "De heer", true);
            } else {
                FishBarrel.FillRadioButton(0, "dhrmevr", "Mevrouw", true);
            }

            FishBarrel.FillFormElement(0, "voorletters", settings.firstName);
            FishBarrel.FillFormElement(0, "achternaam", settings.surname);
            FishBarrel.FillFormElement(0, "adres", settings.address);
            FishBarrel.FillFormElement(0, "postcode", settings.postcode);
            FishBarrel.FillFormElement(0, "woonplaats", settings.city);
            FishBarrel.FillFormElement(0, "telefoonnummer", settings.phonenumber);
            FishBarrel.FillFormElement(0, "email", settings.email);
            FishBarrel.FillFormElement(0, "internet", true);

            var now = new Date();
            FishBarrel.FillFormElement(0, "dag", now.getDate());
            FishBarrel.FillFormElement(0, "maand", now.getMonth() + 1);
            FishBarrel.FillFormElement(0, "jaar", now.getFullYear());
            FishBarrel.FillRadioButton(0, "inetbetreft", "Tekstfragment", true);
            FishBarrel.FillFormElement(0, "inetAfbeelding", "Zie hieronder");
            FishBarrel.FillFormElement(0, "inetAdres_site", response.WebsiteUrl);
            FishBarrel.FillFormElement(0, "adverteerder", response.organisationName);
            FishBarrel.FillFormElement(0, "product", "Alternatieve geneeswijzen");
            FishBarrel.FillFormElement(0, "klachtomschrijving", response.body);
        });
    }
};
Authorities[SRCAuth.Key] = SRCAuth;

/*
##################################################################
NZASA / New Zealand Advertising Standards Authority
##################################################################
*/
var NZASAAuth = {};
NZASAAuth.Key = "NZASA";
NZASAAuth.Country = "New Zealand";
NZASAAuth.Name = "New Zealand Advertising Standards Authority";

// Re-wired 2026-06-18: NZASA moved their complaint form to
// /complaints/make-a-complaint/ and rebuilt it on Forminator (a WordPress
// plugin). Field names are generic (text-1, name-1-first-name, etc.) but
// FormRecorder confirmed semantic labels on every input, so we can map
// them. The form is multi-step but Forminator keeps every step's fields
// in the DOM from page load, so a single fill-everything pass survives
// the user's wizard navigation. Verified live against asa.co.nz: 11 of
// 11 candidate fields filled on first load.
NZASAAuth.ComposeComplaint = function () {
    navigateActiveTab("https://www.asa.co.nz/complaints/make-a-complaint/");
};

NZASAAuth.AutoFillForm = function () {
    if (window.location.href.indexOf("https://www.asa.co.nz/complaints/make-a-complaint") !== 0
        && window.location.href.indexOf("https://asa.co.nz/complaints/make-a-complaint") !== 0) {
        return;
    }
    askIfComplaintReady("NZASA", function (response) {
        if (!response.settingsAttached) return;
        var s = response.settings;
        FishBarrel.FillFirstMatch(["name-1-first-name", "first_name"], s.firstName);
        FishBarrel.FillFirstMatch(["name-1-last-name", "last_name", "surname"], s.surname);
        FishBarrel.FillFirstMatch(["address-1-street_address", "address_1", "street_address"], s.address);
        FishBarrel.FillFirstMatch(["address-1-address_line", "address_2"], s.county);
        FishBarrel.FillFirstMatch(["address-1-city", "town", "city"], s.city);
        FishBarrel.FillFirstMatch(["address-1-zip", "postcode", "post_code", "zip"], s.postcode);
        FishBarrel.FillFirstMatch(["phone-1", "telephone", "phone", "phone_number"], s.phonenumber);
        FishBarrel.FillFirstMatch(["email-1", "email", "email_address"], s.email);
        FishBarrel.FillFirstMatch(["text-1", "advertiser", "advertiser_name"], response.organisationName);
        FishBarrel.FillFirstMatch(["url-1", "advert_url", "advertisement_url"], response.WebsiteUrl);
        FishBarrel.FillFirstMatch(["textarea-1", "complaint", "complaint_details", "description_of_complaint"], response.body);
    });
};
Authorities[NZASAAuth.Key] = NZASAAuth;

/*
##################################################################
FDA / US Food & Drug Administration
##################################################################
*/
var FDAAuth = {};
FDAAuth.Key = "FDA";
FDAAuth.Country = "USA";
FDAAuth.Name = "US Food & Drug Administration";

FDAAuth.ComposeComplaint = function () {
    navigateActiveTab("http://www.accessdata.fda.gov/scripts/email/oc/buyonline/buyonlineform.cfm");
};

FDAAuth.AutoFillForm = function () {
    var url = "http://www.accessdata.fda.gov/scripts/email/oc/buyonline/buyonlineform.cfm";
    if (url != window.location.href) return;

    askIfComplaintReady("FDA", function (response) {
        var settings = response.settings;
        var d = new Date();

        FishBarrel.FillFormElement(1, "web_address", response.WebsiteUrl);
        FishBarrel.FillFormElement(1, "datefound", (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear());
        FishBarrel.FillFormElement(1, "site_owner", response.organisationName);
        FishBarrel.FillFormElement(1, "problem", response.body);

        var phone = (settings.phonenumber || "").replace(/([^0-9])/g, "");
        if (phone.length > 3) {
            if (phone.substring(0, 1) == "1") phone = phone.substring(1);
            FishBarrel.FillFormElement(1, "phoneareacode", phone.substring(0, 3));
            FishBarrel.FillFormElement(1, "phone", phone.substring(3));
        }
        FishBarrel.FillFormElement(1, "faxareacode", "000");
        FishBarrel.FillFormElement(1, "fax", "0000000");

        FishBarrel.FillFormElement(1, "fname", settings.firstName);
        FishBarrel.FillFormElement(1, "lname", settings.surname);
        FishBarrel.FillFormElement(1, "email", settings.email);
        FishBarrel.FillFormElement(1, "street", settings.address);
        FishBarrel.FillFormElement(1, "city", settings.city);
        FishBarrel.FillFormElement(1, "state", settings.county);
        FishBarrel.FillFormElement(1, "zipcode", settings.postcode);

        var form = document.forms[1];
        if (form && form.elements.length > 0) {
            var last = form.elements[form.elements.length - 1];
            last.addEventListener('click', function () { FishBarrel.ComplaintSent("FDA"); }, false);
            last.style.border = "2px solid red";
        }
    });
};
Authorities[FDAAuth.Key] = FDAAuth;

/*
##################################################################
Canadian Competition Bureau
##################################################################
*/
var CanadianCompBureau = {};
CanadianCompBureau.Key = "CanadianCompBureau";
CanadianCompBureau.Country = "Canada";
CanadianCompBureau.Name = "Competition Bureau Canada";

CanadianCompBureau.ComposeComplaint = function () {
    navigateActiveTab("http://www.competitionbureau.gc.ca/eic/site/cb-bc.nsf/frm-eng/GHET-7TDNA5");
};

CanadianCompBureau.AutoFillForm = function () {
    var urlStart = "http://www.competitionbureau.gc.ca/eic/site/cb-bc.nsf/frm-eng/";
    if (window.location.href.indexOf(urlStart) != 0) return;

    if (document.body && document.body.innerText && document.body.innerText.indexOf("Thank you for completing this form.") != -1) {
        FishBarrel.ComplaintSent("CanadianCompBureau");
        return;
    }

    askIfComplaintReady("CanadianCompBureau", function (response) {
        var settings = response.settings;
        FishBarrel.FillElement("companypersonwebsite", response.WebsiteUrl);
        FishBarrel.FillElement("companypersoncompanyname", response.organisationName);
        FishBarrel.FillElement("subjectfield", response.body);
        FishBarrel.FillElement("complainantlastname", settings.surname);
        FishBarrel.FillElement("complainantfirstname", settings.firstName);
        FishBarrel.FillElement("complainantstreetaddress", settings.address);
        FishBarrel.FillElement("complainantcity", settings.city);
        FishBarrel.FillElement("complainantpostalcode", settings.postcode);
        FishBarrel.FillElement("complainantprovincestate", settings.county);
        FishBarrel.FillElement("complainantcountry", "Canada");
        FishBarrel.FillElement("complainantcontactphonenumber", settings.phonenumber);
        FishBarrel.FillElement("complainantemailaddress", settings.email);
        FishBarrel.FillElement("detailscompetitionact-0", true);
        FishBarrel.FillElement("detailsareyouvictimyesno-1", true);
        FishBarrel.FillElement("n049-0", true);
    });
};
Authorities[CanadianCompBureau.Key] = CanadianCompBureau;

/*
##################################################################
Canadian ASC / Advertising Standards Canada
##################################################################
*/
var CanadianASC = {};
CanadianASC.Key = "CanadianASC";
CanadianASC.Country = "Canada";
CanadianASC.Name = "Advertising Standards Canada";
CanadianASC.ValuesFilled = {};

CanadianASC.ComposeComplaint = function () {
    navigateActiveTab("http://www.adstandards.com/eComplaints/#en");
};

CanadianASC.AttemptOneFill = function (id, value) {
    if (CanadianASC.ValuesFilled[id]) return;
    if (document.getElementById(id) != null) {
        FishBarrel.FillElement(id, value);
        CanadianASC.ValuesFilled[id] = true;
    }
};

CanadianASC.AttemptPeriodicFillForm = function () {
    var url = "http://www.adstandards.com/eComplaints";
    if (window.location.href.indexOf(url) != 0) return;

    askIfComplaintReady("CanadianASC", function (response) {
        var settings = response.settings;
        CanadianASC.AttemptOneFill("ddlSalutation", (settings.title || "") + ".");
        CanadianASC.AttemptOneFill("txtFirstName", settings.firstName);
        CanadianASC.AttemptOneFill("txtLastName", settings.surname);
        CanadianASC.AttemptOneFill("txtAddress", settings.address);
        CanadianASC.AttemptOneFill("txtCity", settings.city);
        CanadianASC.AttemptOneFill("ddlProvince", settings.county);
        CanadianASC.AttemptOneFill("txtZip", settings.postcode);
        CanadianASC.AttemptOneFill("txtPhone", settings.phonenumber);
        CanadianASC.AttemptOneFill("txtEmail", settings.email);
        CanadianASC.AttemptOneFill("txtReEmail", settings.email);
        CanadianASC.AttemptOneFill("txtAdvertiser", response.organisationName);
        CanadianASC.AttemptOneFill("txtProdService", "Alternative Medicine");
        CanadianASC.AttemptOneFill("txtWhereSeen", response.WebsiteUrl);
        CanadianASC.AttemptOneFill("txtWhenSeen", new Date());
        CanadianASC.AttemptOneFill("txtDescription", "Web site - see complaint text");
        CanadianASC.AttemptOneFill("txtComplaint", response.body);
        CanadianASC.AttemptOneFill("chkConfirm", true);

        if (document.getElementById("ComplaintResult") != null) {
            FishBarrel.ComplaintSent("CanadianASC");
        }

        window.setTimeout(CanadianASC.AttemptPeriodicFillForm, 300);
    });
};

CanadianASC.AutoFillForm = function () {
    CanadianASC.ValuesFilled = {};
    CanadianASC.AttemptPeriodicFillForm();
};
Authorities[CanadianASC.Key] = CanadianASC;

/*
##################################################################
CRP / Complaints Resolution Panel (Australia)
##################################################################
*/
var CRPAuth = {};
CRPAuth.Key = "CRP";
CRPAuth.Country = "Australia";
CRPAuth.Name = "Complaints Resolution Panel";

CRPAuth.ComposeComplaint = function () {
    navigateActiveTab("http://www.tgacrp.com.au/index.cfm?pageID=12");
};

CRPAuth.HandlePage1SubmitButton = function () {
    function IncludeEl(el) {
        if (el.type == "radio") return el.checked;
        if (el.type == "checkbox") return el.checked;
        return true;
    }

    var boundary = "----WebKitFormBoundaryttdDBxi1AkDvlRXW";

    function GenerateMultipartRequest(form) {
        var s = "--" + boundary + "\r\n";
        for (var i = 0; i < form.elements.length; i++) {
            var el = form.elements[i];
            if (IncludeEl(el)) {
                s += "Content-Disposition: form-data; name=\"" + el.name + "\"";
                if (el.name == "doc_file_name") {
                    s += "; filename=\"NoContent.txt\"";
                    s += "\r\nContent-Type: text/plain";
                    s += "\r\n\r\n";
                    s += "All information was entered into the form.";
                } else {
                    if (el.type == "file") {
                        s += "; filename=\"\"";
                        s += "\r\nContent-Type: application/octet-stream";
                    }
                    s += "\r\n\r\n";
                    s += el.value;
                }
                s += "\r\n--" + boundary + "\r\n";
            }
        }
        return s;
    }

    var request = GenerateMultipartRequest(document.forms[0]);
    var xmlRequest = new XMLHttpRequest();
    xmlRequest.onreadystatechange = function () {
        if (xmlRequest.readyState == 4) {
            document.write(xmlRequest.responseText);
            if (document.forms[0]) document.forms[0].elements["complaintFormVerifyString"].focus();
        }
    };
    xmlRequest.open("POST", "http://www.tgacrp.com.au/index.cfm?special=complaint_confirmation", false);
    xmlRequest.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
    xmlRequest.send(request);
};

CRPAuth.AutoFillForm = function () {
    var thankyou = "http://www.tgacrp.com.au/INDEX.CFM?SPECIAL=CRP_ACKNOWLEDGMENT";
    if (thankyou == window.location.href) {
        FishBarrel.ComplaintSent("CRP");
        return;
    }

    var formUrl = "http://www.tgacrp.com.au/index.cfm?pageID=12";
    if (formUrl != window.location.href) return;

    if (document.forms[0] && document.forms[0].elements["complaintDetails"]) {
        document.forms[0].elements["complaintDetails"].rows = 30;
        document.forms[0].action = "about:blank";
        document.forms[0].target = "_blank";
        document.forms[0].onsubmit = function () { return false; };
        document.forms[0].elements["Submit"].type = "button";
        document.forms[0].elements["Submit"].onclick = CRPAuth.HandlePage1SubmitButton;

        for (var i = 0; i < document.forms[0].elements.length; i++) {
            var el = document.forms[0].elements[i];
            if (el.type == "file") el.style.display = "none";
        }
    }

    askIfComplaintReady("CRP", function (response) {
        if (!response.settingsAttached) return;
        var settings = response.settings;

        FishBarrel.FillFormElement(0, "pubName", response.WebsiteUrl);
        FishBarrel.FillFormElement(0, "pubDate", textDate(new Date()));
        FishBarrel.FillFormElement(0, "prodName", "Alternative Health");
        FishBarrel.FillFormElement(0, "complaintDetails", response.body);
        FishBarrel.FillFormElement(0, "complainant", (settings.firstName || "") + " " + (settings.surname || ""));

        var fullAddr = settings.address || "";
        if (settings.city) fullAddr += ", " + settings.city;
        if (settings.county) fullAddr += ", " + settings.county;

        FishBarrel.FillFormElement(0, "complainant_address", fullAddr);
        FishBarrel.FillFormElement(0, "complainant_postal_code", settings.postcode);
        FishBarrel.FillFormElement(0, "complainant_telephone", settings.phonenumber);
        FishBarrel.FillFormElement(0, "complainant_email", settings.email);
        FishBarrel.FillFormElement(0, "flag_acceptance", true);

        if (document.forms[0]) {
            document.forms[0].addEventListener('submit', function () { FishBarrel.ComplaintSent("CRP"); }, false);
        }
        alert("Please review, submit and then complete the CAPTCHA on the next page to submit.");
    });
};
Authorities[CRPAuth.Key] = CRPAuth;

/*
##################################################################
ACCC / Australian Competition & Consumer Commission
##################################################################
*/
var ACCCAuth = {};
ACCCAuth.Key = "ACCC";
ACCCAuth.Country = "Australia";
ACCCAuth.Name = "Australian Competition & Consumer Commission";

ACCCAuth.ComposeComplaint = function () {
    navigateActiveTab("http://www.accc.gov.au/content/maintain/create/index.phtml?contentTypeItemId=9133&informationSpaceItemId=268347&inPop=1&returnUrl=.&type=Other");
};

ACCCAuth.AutoFillForm = function () {
    var url = "http://www.accc.gov.au/content/maintain/create/index.phtml?contentTypeItemId=9133&informationSpaceItemId=268347&inPop=1&returnUrl=.&type=Other";
    if (url != window.location.href) return;

    askIfComplaintReady("ACCC", function (response) {
        var settings = response.settings;
        var saveAndClose = document.getElementById('saveAndClose');
        if (saveAndClose) {
            saveAndClose.addEventListener('click', function () { FishBarrel.ComplaintSent("ACCC"); }, false);
        }

        FishBarrel.FillFormElement(0, "/FORM/acccComplaint/title", settings.title);
        FishBarrel.FillElement("acccComplaint.firstName", settings.firstName);
        FishBarrel.FillElement("acccComplaint.lastName", settings.surname);
        FishBarrel.FillElement("acccComplaint.address", settings.address);
        FishBarrel.FillElement("acccComplaint.suburb", settings.city);
        FishBarrel.FillElement("acccComplaint.city", settings.county);
        FishBarrel.FillElement("acccComplaint.postcode", settings.postcode);
        FishBarrel.FillElement("acccComplaint.businessHoursPhoneNumber", settings.phonenumber);
        FishBarrel.FillElement("acccComplaint.emailAddress", settings.email);
        FishBarrel.FillElement("/acccComplaint/scamType", "medical");
        FishBarrel.FillElement("acccComplaint.productDescription", response.organisationName);
        FishBarrel.FillElement("acccComplaint.productProvider", response.organisationName);
        FishBarrel.FillElement("acccComplaint.complaintDescription", response.body);
    });
};
Authorities[ACCCAuth.Key] = ACCCAuth;

/*
##################################################################
ASAI / Advertising Standards Authority of Ireland
##################################################################
*/
var ASAIAuth = {};
ASAIAuth.Key = "ASAI";
ASAIAuth.Country = "Ireland";
ASAIAuth.Name = "Advertising Standards Authority of Ireland";

// Re-wired 2026-06-18: ASAI rebranded as "Advertising Standards" on
// adstandards.ie. The current form is a Gravity Forms wizard at
// /make-a-complaint/make-a-complaint/. Fields use Gravity's input_NN
// naming but every input has a recoverable label, so the mapping is
// semantic. Verified live: 14 of 14 candidate fields fill on first
// load including the consent checkbox.
ASAIAuth.ComposeComplaint = function () {
    navigateActiveTab("https://adstandards.ie/make-a-complaint/make-a-complaint/");
};

ASAIAuth.AutoFillForm = function () {
    if (window.location.href.indexOf("https://adstandards.ie/make-a-complaint/make-a-complaint") !== 0) return;
    askIfComplaintReady("ASAI", function (response) {
        if (!response.settingsAttached) return;
        var s = response.settings;
        // Consent checkbox — has to be ticked for the rest of the form to
        // activate.
        FishBarrel.FillByName("input_68.1", true);

        // Personal details (Gravity Forms "Advanced Name" + "Address" fields)
        FishBarrel.FillFirstMatch(["input_63.3", "first_name"], s.firstName);
        FishBarrel.FillFirstMatch(["input_63.6", "last_name", "surname"], s.surname);
        FishBarrel.FillFirstMatch(["input_65.1", "address_1", "street_address"], s.address);
        FishBarrel.FillFirstMatch(["input_65.3", "city", "town"], s.city);
        FishBarrel.FillFirstMatch(["input_65.4", "county", "region"], s.county);
        FishBarrel.FillFirstMatch(["input_65.5", "postcode", "post_code", "eircode", "zip"], s.postcode);
        FishBarrel.FillFirstMatch(["input_65.6"], "United Kingdom"); // country (select)
        FishBarrel.FillFirstMatch(["input_99", "telephone", "phone", "phone_number"], s.phonenumber);
        FishBarrel.FillFirstMatch(["input_100", "email", "email_address"], s.email);

        // Advertisement details
        FishBarrel.FillFirstMatch(["input_14", "advertiser", "advertiser_name"], response.organisationName);
        FishBarrel.FillFirstMatch(["input_15", "product", "product_service"], "Alternative Health");
        FishBarrel.FillFirstMatch(["input_33", "advert_url", "url"], response.WebsiteUrl);
        FishBarrel.FillFirstMatch(["input_31", "description_of_ad"], "See the body of the complaint below.");
        FishBarrel.FillFirstMatch(["input_58", "complaint", "complaint_details", "description_of_complaint"], response.body);
    });
};
Authorities[ASAIAuth.Key] = ASAIAuth;

/*
##################################################################
MHRA
##################################################################
*/
var MHRAAuth = {};
MHRAAuth.Key = "MHRA";
MHRAAuth.Country = "UK";
MHRAAuth.Name = "MHRA";

MHRAAuth.ComposeComplaint = function () {
    navigateActiveTab("http://www.mhra.gov.uk/Howweregulate/Medicines/Advertisingofmedicines/Advertisinginvestigations/Advertisingcomplaintform/index.htm");
};

MHRAAuth.AutoFillForm = function () {
    var url = "http://www.mhra.gov.uk/Howweregulate/Medicines/Advertisingofmedicines/Advertisinginvestigations/Advertisingcomplaintform/index.htm";
    if (url != window.location.href) return;

    if (document.body && document.body.innerHTML.indexOf("Thank you for your submission") != -1) {
        FishBarrel.ComplaintSent("MHRA");
        return;
    }

    askIfComplaintReady("MHRA", function (response) {
        if (response.CurrentComplaintFilled) return;

        if (response.body) {
            FishBarrel.FillElement("Complaint", response.body);
            FishBarrel.FillElement("PleaseSpecifyCompany", response.organisationName);
        }

        if (response.settingsAttached) {
            var settings = response.settings;
            FishBarrel.FillElement("MemberOfPublic", true);
            FishBarrel.FillElement("Title", settings.title);
            FishBarrel.FillElement("FirstName", settings.firstName);
            FishBarrel.FillElement("Surname", settings.surname);
            FishBarrel.FillElement("PostalAddress", settings.address);
            FishBarrel.FillElement("City", settings.city);
            FishBarrel.FillElement("PostCode", settings.postcode);
            FishBarrel.FillElement("Country", "UK");
            FishBarrel.FillElement("PhoneNumber", settings.phonenumber);
            FishBarrel.FillElement("EmailAddress", settings.email);
            FishBarrel.FillElement("ConfirmEmailAddress", settings.email);
            FishBarrel.FillElement("AdvertMedium", "fieldInternet");
            FishBarrel.FillElement("AdvertDetails", "The information was found at " + response.WebsiteUrl);
            FishBarrel.FillElement("Medicine", "");

            var med = document.getElementById("Medicine");
            if (med && med.value == "") {
                med.style.border = "3px solid red";
                med.focus();
                alert("Please fill out the name of the medicine, review your complaint and then submit the form.");
            }
        }

        chrome.runtime.sendMessage({ type: "setComplaintFilled" });
    });
};
Authorities[MHRAAuth.Key] = MHRAAuth;

/*
##################################################################
ASA / Advertising Standards Authority (UK)
##################################################################

The ASA's complaint form was rebuilt around 2020. The old multi-page ASP.NET
flow (Step1.aspx ... Step5.aspx with `phmain_0_phtop_1_*` field ids) is gone.

The current form lives at a single URL — https://www.asa.org.uk/make-a-complaint.html
— and re-renders inline as the user clicks Continue. Field names are now
lowercase snake_case (`address_1`, `town`, `country`, `advert_url`,
`complaint_advertisement_type_level_1/2/3`, etc.). Importantly, the form is
JS-driven and changes which fields are visible based on user choices; FishBarrel
can't predict which advertisement type / topic the user will pick, so those
cascading selects are left for the user to fill.

A MutationObserver re-runs the autofill each time the page re-renders a new
step so contact details, the description, and the advert URL get populated as
their fields appear. Continue buttons are NOT clicked automatically — the user
walks through the form themselves so they can review each step.
*/
var ASAAuth = {};
ASAAuth.Key = "ASA";
ASAAuth.Country = "UK";
ASAAuth.DisallowHomeopathy = false;
ASAAuth.ForceJustification = true;
ASAAuth.Name = "Advertising Standards Authority";

// The "I am a member of the public" option of the about_the_complaint radio.
// Extracted from the make_a_complaint JS bundle.
ASAAuth.PUBLIC_COMPLAINT_GUID = "7387371E-ED8F-4BFB-B1ADCB86894B7FB6";

ASAAuth.ComposeComplaint = function () {
    navigateActiveTab("https://www.asa.org.uk/make-a-complaint.html");
};

ASAAuth.AutoFillForm = function () {
    if (window.location.href.indexOf("https://www.asa.org.uk/make-a-complaint") != 0
        && window.location.href.indexOf("http://www.asa.org.uk/make-a-complaint") != 0) {
        return;
    }

    // Diagnostic recorder: always-on for the ASA URL so the form's exact field
    // names, ids and labels are captured in the console as the user walks
    // through. Copy the console output back to update the autofill wiring.
    FishBarrel.FormRecorder.init("ASA");

    // Heuristic submission detection: if the page now reads as a thank-you
    // page, mark the complaint as submitted and stop.
    var bodyText = (document.body && document.body.innerText) || "";
    if (/thank\s*you[\s\S]{0,60}complaint/i.test(bodyText) && bodyText.length < 4000) {
        FishBarrel.ComplaintSent("ASA");
        return;
    }

    askIfComplaintReady("ASA", function (response) {
        if (!response.settingsAttached || !response.body) return;

        ASAAuth.TryFill(response);

        // The form swaps in new step HTML in place. Re-attempt fills whenever
        // the DOM mutates so step 2's address fields, step N's description box,
        // etc. all get populated as they appear.
        if (!ASAAuth._observing) {
            ASAAuth._observing = true;
            var pending = null;
            var observer = new MutationObserver(function () {
                if (pending) return;
                pending = window.setTimeout(function () {
                    pending = null;
                    ASAAuth.TryFill(response);
                }, 80);
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    });
};

// Walk through every field FishBarrel knows how to populate. Each call is a
// no-op for fields not currently in the DOM, so it's safe to invoke repeatedly
// as the form progresses through steps.
// Resolve the actual complaint form on the page (not the search/login forms
// that share the layout). Prefer the canonical id, fall back to any form whose
// action endpoint looks like a complaint-step submission.
ASAAuth.findComplaintForm = function () {
    var f = document.getElementById("form-make-a-complaint");
    if (f) return f;
    for (var i = 0; i < document.forms.length; i++) {
        if ((document.forms[i].action || "").indexOf("saveComplaintStep") !== -1) {
            return document.forms[i];
        }
    }
    return null;
};

ASAAuth.TryFill = function (response) {
    var settings = response.settings || {};

    // The intro step has nothing to fill — just an explanatory blurb, a hidden
    // CSRF token and a Continue button. Auto-click it so the user lands
    // directly on the first step with fillable fields. Subsequent Continues
    // are left to the user so they can review what FishBarrel filled in.
    //
    // We NEVER auto-click the final SUBMIT COMPLAINT button. The button id
    // happens to be reused across steps (it's also `continue-button` on
    // the final step), so we additionally check that the button's visible
    // text doesn't contain "submit" — that's a hard tripwire against auto-
    // submitting, even if something later goes wrong with the action check.
    // ASA's final step also gates on Cloudflare Turnstile, which only a
    // human can satisfy.
    var form = ASAAuth.findComplaintForm();
    if (form && form.action && form.action.indexOf("saveComplaintStepintro") !== -1 && !ASAAuth._introClicked) {
        var introBtn = document.getElementById("continue-button");
        if (introBtn) {
            var btnText = ((introBtn.innerText || "") + "").trim().toLowerCase();
            if (btnText.indexOf("submit") === -1) {
                ASAAuth._introClicked = true;
                introBtn.click();
                return;
            }
        }
    }

    // Mark the complainant as a member of the public (radio appears on the
    // first step after the intro).
    FishBarrel.SelectRadioByValue("about_the_complaint", ASAAuth.PUBLIC_COMPLAINT_GUID);

    // Type of ad: FishBarrel only captures online quackery, so the
    // top-level "where did you see the ad" cascade always starts at
    // "Online" (GUID extracted from ASA's make_a_complaint JS bundle).
    // Without this the page blocks at the first step waiting for a
    // selection. Level 2 (search engine / social / website / streaming
    // / etc) and level 3 stay user-pick because that varies per
    // complaint.
    FishBarrel.FillByName("complaint_advertisement_type_level_1", "DF57F934-69FB-4796-A4BC773A5361AEAB");

    // Personal-detail field names confirmed against the live form (snapshot
    // 2026-06-17). The fallback candidates stay for other authorities.
    FishBarrel.FillFirstMatch(["title", "salutation"], settings.title);
    FishBarrel.FillFirstMatch(["first_name", "firstname", "fname", "given_name"], settings.firstName);
    FishBarrel.FillFirstMatch(["last_name", "surname", "lname", "family_name"], settings.surname);
    FishBarrel.FillFirstMatch(["email", "email_address"], settings.email);
    FishBarrel.FillFirstMatch(["confirm_email", "email_address_confirm", "retype_email"], settings.email);

    // Address: ASA's registration step has address_1, address_2, address_3 plus
    // town/postcode/country. There's no separate county input, so we splice
    // any stored county into the next free address line.
    ASAAuth.fillAddress(settings);

    FishBarrel.FillFirstMatch(["town", "city"], settings.city);
    FishBarrel.FillFirstMatch(["postcode", "post_code", "zip", "zipcode"], settings.postcode);
    FishBarrel.FillFirstMatch(["country"], "United Kingdom");
    FishBarrel.FillFirstMatch(["telephone", "phone", "phone_number", "telephone_number"], settings.phonenumber);

    // The registration step also has an `organisation_name` field for the
    // user's employer — INTENTIONALLY NOT FILLED. The advertiser the user is
    // complaining about is a different concept and lives on the later
    // complaint-detail step under a different field name (TBC). Putting the
    // advertiser into the registration's organisation_name would be wrong.

    // Where the ad was seen.
    FishBarrel.FillFirstMatch(["advert_url", "advertisement_url", "url", "url_seen", "where_seen"], response.WebsiteUrl);

    // Advertiser. `organisation_name` deliberately excluded — see note above;
    // it's the registration's "employer" field, not the advertiser.
    FishBarrel.FillFirstMatch(["advertiser", "advertiser_name", "company", "company_name"], response.organisationName);
    FishBarrel.FillFirstMatch(["product", "product_description", "product_service", "what"], "Alternative Medicine");

    // The complaint body. ASA's textarea is `description_of_complaint`
    // (confirmed against the live form). Fallback names kept for other
    // authorities and any future renames.
    FishBarrel.FillFirstMatch(["description_of_complaint", "complaint", "complaint_details", "complaint_description", "description", "details", "complaint_text", "your_complaint"], response.body);

    // Mark the in-progress complaint as filled so the popup state reflects it.
    chrome.runtime.sendMessage({ type: "setComplaintFilled" });
};

// Spread the user's address across address_1, address_2, address_3. The
// stored address may be a single line ("123 Main St") or multi-line ("Flat 4
// / 123 Main St"); we also append the stored county if there's space.
ASAAuth.fillAddress = function (settings) {
    var lines = ((settings.address || "") + "")
        .split(/\r?\n/)
        .map(function (l) { return l.trim(); })
        .filter(Boolean);

    var county = ((settings.county || "") + "").trim();
    if (county && lines.indexOf(county) === -1) lines.push(county);

    FishBarrel.FillFirstMatch(["address_1", "address1", "address", "street", "street_address"], lines[0] || "");
    if (document.getElementsByName("address_2").length > 0) {
        FishBarrel.FillByName("address_2", lines[1] || "");
    }
    if (document.getElementsByName("address_3").length > 0) {
        FishBarrel.FillByName("address_3", lines[2] || "");
    }
};
Authorities[ASAAuth.Key] = ASAAuth;

/*
##################################################################
DKMA / Danish Medicines Agency
##################################################################
*/
var DKMAAuth = {};
DKMAAuth.Key = "DKMA";
DKMAAuth.Country = "Denmark";
DKMAAuth.Name = "Danish Medicines Agency";

DKMAAuth.ComposeComplaint = function () {
    var company = ClaimGroup.Current ? ClaimGroup.Current.CompanyName(true) : "";
    var to = "<dkma@dkma.dk>";
    var subject = "Klage (complaint) / " + company;
    var url = "https://mail.google.com/mail/h/?v=b&cs=wh&f=1"
        + "&to=" + encodeURIComponent(to)
        + "&subject=" + encodeURIComponent(subject);
    DKMAAuth.LastUrl = url;
    chrome.tabs.create({ url: url });
};

DKMAAuth.AutoFillForm = function () {
    if ((window.location.href.indexOf("dkma@dkma.dk") != -1) && (window.location.href.indexOf("https://mail.google.com/") == 0)) {
        askIfComplaintReady("DKMA", function (response) {
            FishBarrel.FillFormElement(1, 'body', response.body);
            if (document.forms[1] && document.forms[1].elements['nvp_bu_send']) {
                var btns = document.forms[1].elements['nvp_bu_send'];
                if (btns[0]) btns[0].addEventListener('click', function () { FishBarrel.ComplaintSent("DKMA"); }, false);
                if (btns[1]) btns[1].addEventListener('click', function () { FishBarrel.ComplaintSent("DKMA"); }, false);
            }
        });
    }
};
Authorities[DKMAAuth.Key] = DKMAAuth;

function textDate(date) {
    var months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
    var year = date.getFullYear();
    return date.getDate() + " " + months[date.getMonth()] + ", " + year;
}

/*
##################################################################
Broken-authority overrides (post-2026 audit)
##################################################################

Every authority below was confirmed broken by the automated audit on
2026-06-18: the configured ComposeComplaint URL either returns a page
with no form (regulator restructured their site), redirects to a
search / contact page, or relies on a discontinued upstream service
(Gmail's basic-HTML "?v=b" compose URL, retired by Google in 2024).

The original per-authority blocks above are kept so a future revival
can lift their field-mapping knowledge. markBroken() runs AFTER each
authority's normal definition, replacing its ComposeComplaint and
AutoFillForm so clicking the button just opens the regulator's
top-level / contact page in a new tab.

ASA is intentionally NOT in this list — its 2026 rewrite still works.
*/

markBroken(MHRAAuth,
    "MHRA's complaint form has moved off mhra.gov.uk. Use the gov.uk 'report a problem with a medicine or medical device' flow.",
    "https://www.gov.uk/report-problem-medicine-medical-device");

markBroken(ACCCAuth,
    "ACCC's old complaint endpoint is gone. The replacement is the consumer 'problem with a product or service you bought' flow.",
    "https://www.accc.gov.au/consumers/problem-with-a-product-or-service-you-bought");

markBroken(CRPAuth,
    "The Complaints Resolution Panel was dissolved; advertising complaints in Australia now go through the TGA's Report a Breach flow.",
    "https://www.tga.gov.au/safety/report-problem/report-breach");

markBroken(FDAAuth,
    "FDA's 'buy online' complaint form is no longer hosted; the catch-all 'Report a Problem' page is the current route.",
    "https://www.fda.gov/safety/report-problem-fda");

markBroken(CanadianCompBureau,
    "The Competition Bureau moved domains (competition-bureau.canada.ca) and rebuilt the deceptive-marketing report flow. Old wiring no longer matches.",
    "https://competition-bureau.canada.ca/en/how-we-foster-competition/deceptive-marketing-practices/report-deceptive-marketing-practice");

markBroken(CanadianASC,
    "Ad Standards Canada moved its public complaint form to complaints.adstandards.ca. It's a multi-step .NET WebForm; not autonomously wireable yet.",
    "https://complaints.adstandards.ca/pub/complaints?lang=en");

markBroken(SRCAuth,
    "Stichting Reclame Code's new klachtenformulier page describes how to complain but doesn't embed a form on-page; follow the instructions there.",
    "https://www.reclamecode.nl/klacht-indienen/klachtenformulier/");

markBroken(VZHHAuth,
    "Used the legacy Gmail basic-HTML compose URL, which Google discontinued in 2024. Contact Verbraucherzentrale Hamburg directly.",
    "https://www.vzhh.de/themen/markt-recht");

markBroken(DKMAAuth,
    "Used the legacy Gmail basic-HTML compose URL, which Google discontinued in 2024. The Danish Medicines Agency (Lægemiddelstyrelsen) now uses a web form.",
    "https://laegemiddelstyrelsen.dk/en/contact/");
