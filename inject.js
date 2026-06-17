// FishBarrel content script. Runs in every http(s) frame.

function FishBarrel() {}

FishBarrel.lastSelection = "";
FishBarrel.FormElementsToMonitor = [];
FishBarrel.MonitorFormElementsLoopRunning = false;
FishBarrel.initialised = false;

FishBarrel.Init = function () {
    if (FishBarrel.initialised) return;
    FishBarrel.initialised = true;

    var href = window.document.location.href;
    if (href.indexOf("http://platform.twitter.com") == 0) return;
    if (href.indexOf("http://www.facebook.com/plugins") == 0) return;
    if (href.indexOf("https://platform.twitter.com") == 0) return;
    if (href.indexOf("https://www.facebook.com/plugins") == 0) return;

    window.document.addEventListener('mouseup', FishBarrel.OnMouseUp, false);
    FishBarrel.HighlightExistingText();
};

FishBarrel.Kill = function (element) {
    var claimId = element.id.substring(3);
    claimId = claimId.substring(0, claimId.indexOf("_"));
    chrome.runtime.sendMessage({ type: "deleteClaim", claimId: claimId });

    var spans = document.getElementsByTagName("FishBarrelHLSpan");
    var prefix = "HL_" + claimId + "_";
    for (var i = spans.length - 1; i >= 0; i--) {
        var el = spans[i];
        if (el.id.indexOf(prefix) == 0) {
            el.outerHTML = el.innerHTML;
        }
    }
};

FishBarrel.UnhighlightAll = function () {
    var spans = document.getElementsByTagName("FishBarrelHLSpan");
    for (var i = spans.length - 1; i >= 0; i--) {
        var el = spans[i];
        if (el.className && el.className.indexOf("FishBarrel") == 0) {
            el.setAttribute("style", "");
            el.setAttribute("className", "");
            el.outerHTML = el.innerHTML;
        }
    }
};

FishBarrel.FillRadioButton = function (formIndex, elementName, elementValue, value) {
    var form = document.forms[formIndex];
    if (!form) return;
    var elements = form.elements[elementName];
    if (!elements) return;

    var el = null;
    for (var i = 0; i < elements.length; i++) {
        if (elements[i].value == elementValue) el = elements[i];
    }
    if (!el) return;

    FishBarrel.FillElementByObjectReference(el, value);

    var idx = FishBarrel.FormElementsToMonitor.length;
    FishBarrel.FormElementsToMonitor[idx] = {
        id: null,
        formIndex: formIndex,
        name: elementName,
        referenceName: elementName
    };
    FishBarrel.CaptureElementText(idx);
    FishBarrel.MonitorFormElements();
};

FishBarrel.FillFormElement = function (formIndex, elementName, value) {
    var form = document.forms[formIndex];
    if (!form) return;
    var el = form.elements[elementName];
    if (!el) return;

    FishBarrel.FillElementByObjectReference(el, value);

    var idx = FishBarrel.FormElementsToMonitor.length;
    FishBarrel.FormElementsToMonitor[idx] = {
        id: null,
        formIndex: formIndex,
        name: elementName,
        referenceName: elementName
    };
    FishBarrel.CaptureElementText(idx);
    FishBarrel.MonitorFormElements();
};

FishBarrel.CaptureElementText = function (idx) {
    var spec = FishBarrel.FormElementsToMonitor[idx];
    var e;
    if (spec.id != null) {
        e = document.getElementById(spec.id);
    } else {
        var form = document.forms[spec.formIndex];
        if (!form) return;
        e = form.elements[spec.name];
    }
    if (!e) return;

    var name = e.name;
    var value = e.value;
    if (e.type == "select-one") {
        value = e.options[e.selectedIndex].text;
    }

    chrome.runtime.sendMessage({ type: "registerFormDataChange", name: name, value: value });
};

FishBarrel.MonitorFormElements = function () {
    if (FishBarrel.MonitorFormElementsLoopRunning) return;
    FishBarrel.MonitorFormElementsLoopRunning = true;
    FishBarrel.MonitorFormElementsLoop();
};

FishBarrel.MonitorFormElementsLoop = function () {
    for (var i = 0; i < FishBarrel.FormElementsToMonitor.length; i++) {
        var spec = FishBarrel.FormElementsToMonitor[i];
        var el = spec.id ? document.getElementById(spec.id) : null;
        if (el) {
            (function (index) {
                el.onchange = function () { FishBarrel.CaptureElementText(index); };
            })(i);
        }
    }
    window.setTimeout(FishBarrel.MonitorFormElementsLoop, 1000);
};

FishBarrel.FillElementByObjectReference = function (el, value) {
    try {
        var t = el.type || (el.tagName || "").toLowerCase();
        if (t == "text" || t == "email" || t == "tel" || t == "url" || t == "search" || t == "number" || t == "date" || t == "password" || t == "textarea") {
            el.value = value;
        } else if (t == "checkbox" || t == "radio") {
            el.checked = !!value;
        } else if (t == "select-one" || t == "select-multiple" || el.tagName == "SELECT") {
            for (var i = 0; i < el.options.length; i++) {
                if (el.options[i].value == value || el.options[i].text == value) {
                    el.selectedIndex = i;
                    break;
                }
            }
        }
        // Notify any JS framework wired to the field that its value changed.
        // Without this, React/Vue/Alpine-driven forms ignore programmatic value sets.
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (oErr) {
        // form element shape didn't match what authority expected; skip silently
    }
};

// Fill every input matching the given `name` attribute (across all forms).
// Returns true if at least one element matched.
FishBarrel.FillByName = function (name, value) {
    var els = document.getElementsByName(name);
    var any = false;
    for (var i = 0; i < els.length; i++) {
        FishBarrel.FillElementByObjectReference(els[i], value);
        any = true;
    }
    return any;
};

// Try each candidate name in order; fill the first one that exists. Returns
// the name that matched, or null if nothing did.
FishBarrel.FillFirstMatch = function (candidates, value) {
    for (var i = 0; i < candidates.length; i++) {
        if (FishBarrel.FillByName(candidates[i], value)) return candidates[i];
    }
    return null;
};

// Set a specific radio in a radio-group to checked by value (different from
// FillByName which would tick every radio in the group). Uses a real click
// so JS frameworks see the same sequence of events a user would generate.
FishBarrel.SelectRadioByValue = function (name, value) {
    var els = document.getElementsByName(name);
    for (var i = 0; i < els.length; i++) {
        if (els[i].type == "radio" && els[i].value == value) {
            if (els[i].checked) return true; // already done, don't loop the observer
            els[i].click();
            // Belt-and-braces: also fire change, in case the page's JS only
            // wired change-listeners and ignores click.
            els[i].dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
    }
    return false;
};

FishBarrel.FillElement = function (elementId, value) {
    var el = document.getElementById(elementId);
    if (!el) return;

    FishBarrel.FillElementByObjectReference(el, value);

    var idx = FishBarrel.FormElementsToMonitor.length;
    FishBarrel.FormElementsToMonitor[idx] = {
        id: el.id,
        formIndex: null,
        name: null,
        referenceName: el.id
    };
    FishBarrel.CaptureElementText(idx);
    FishBarrel.MonitorFormElements();
};

if (!String.prototype.trim) {
    String.prototype.trim = function () { return this.replace(/^\s+|\s+$/g, ""); };
}

FishBarrel.OnMouseUp = function () {
    var tmpSelection = window.getSelection() + "";
    if (tmpSelection == "") return;
    if (tmpSelection == FishBarrel.lastSelection) return;

    var textRangeToStringFormatText = window.getSelection().getRangeAt(0).toString().trim();
    if (textRangeToStringFormatText.length < 5) return;

    var instanceSelected = WhichInstanceOfTextIsSelected();
    window.getSelection().removeAllRanges();

    chrome.runtime.sendMessage({
        type: "addClaim",
        instanceSelected: instanceSelected,
        selectedText: "" + tmpSelection.trim(),
        url: "" + window.location.href,
        textRangeToStringFormatText: textRangeToStringFormatText
    }, function (response) {
        if (response) FishBarrel.HighlightText(response);
    });

    FishBarrel.lastSelection = tmpSelection;
};

FishBarrel.HighlightExistingText = function () {
    // Previously this asked the server for claims other users had reported on
    // this URL. With the server gone, the response is always an empty list.
    // The local highlighter still runs so the user sees their own captures.
    chrome.runtime.sendMessage({ type: "getExistingClaimsForUrl", url: window.location.href }, function () {
        FishBarrel.HighlightText();
    });
};

FishBarrel.HighlightText = function (data) {
    var nextClaimIndex = 0;
    if (data) {
        HighlightText(data.textToHighlight, data.id, data.instanceSelected,
            "FishBarrel_highlightedByCurrentUser",
            "This text was selected by you. Left-click to remove.", true);
        nextClaimIndex = data.claimIndex + 1;
    }

    chrome.runtime.sendMessage({
        type: "getNextClaimForUrl",
        url: window.location.href,
        claimIndex: nextClaimIndex
    }, function (response) {
        if (response) FishBarrel.HighlightText(response);
    });
};

FishBarrel.ComplaintSent = function (authority) {
    chrome.runtime.sendMessage({ type: "complaintSent", Authority: authority });
};

// Listen for unhighlight requests from the service worker.
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request && request.type == "unhighlightAll") {
        FishBarrel.UnhighlightAll();
        sendResponse({ ok: true });
        return;
    }
});

// On page load, ask the service worker whether capture is active. If it is,
// initialise so new pages get the mouseup listener automatically.
chrome.runtime.sendMessage({ type: "checkCapture" }, function (response) {
    if (response && response.capture) {
        FishBarrel.Init();
    }
});

// Authorities expose AutoFillForm hooks that run when a regulator's form page
// loads. They use chrome.runtime.sendMessage to ask the service worker for the
// composed complaint body and the user's saved settings.
for (var key in Authorities) {
    try {
        if (typeof Authorities[key].AutoFillForm == "function") {
            Authorities[key].AutoFillForm();
        }
    } catch (e) {
        console.error("Authority autofill failed:", key, e);
    }
}

// ################################################################################################
// ################  HIGHLIGHTING ENGINE  #########################################################
// ################################################################################################
// (Unchanged from the original, except for a couple of var-hoisting fixes.)

function HighlightText(textToFind, claimId, instanceSelected, cssClass, infoText, allowRemove) {
    var range = document.createRange();
    var startNode = document.body;
    var endNode = document.body;
    if (!startNode) return false;

    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.childNodes.length);

    var numberOfInstancesOfTextInDocument = CountMatchesInRange(range, textToFind);
    if (numberOfInstancesOfTextInDocument < instanceSelected) return false;

    var noOfInstancesFromStartPointToEnd = numberOfInstancesOfTextInDocument - instanceSelected + 1;

    while (startNode.hasChildNodes()) {
        var exit = false;
        for (var startNodeIndex = startNode.childNodes.length - 1; startNodeIndex >= 0 && !exit; startNodeIndex--) {
            var startSubNode = startNode.childNodes[startNodeIndex];
            if (startNode.parentNode != null) {
                range.setStart(startSubNode, 0);
                if (CountMatchesInRange(range, textToFind) >= noOfInstancesFromStartPointToEnd) {
                    exit = true;
                    startNode = startSubNode;
                }
            }
        }
    }

    var matchesFoundFromBeginningOfStartNodeToEnd = CountMatchesInRange(range, textToFind);
    var nodePtr = startNode;
    var tmpRange = document.createRange();

    var found = false;
    var endPos = 0;
    while (!found) {
        tmpRange.setStart(startNode, 0);
        while (nodePtr.hasChildNodes()) {
            nodePtr = nodePtr.childNodes[0];
        }
        tmpRange.setStart(startNode, 0);
        endPos = 0;
        if (nodePtr.length) endPos = nodePtr.length;
        tmpRange.setEnd(nodePtr, endPos);

        if (tmpRange.toString().indexOf(textToFind) != -1) {
            found = true;
            endNode = nodePtr;
            range = tmpRange;
        } else {
            while (nodePtr && nodePtr.nextSibling == null) {
                nodePtr = nodePtr.parentNode;
                if (!nodePtr) return false;
            }
            nodePtr = nodePtr.nextSibling;
        }
    }

    var additionalMatchesBeforeThis = matchesFoundFromBeginningOfStartNodeToEnd - noOfInstancesFromStartPointToEnd;
    var matchesRequired = additionalMatchesBeforeThis + 1;

    found = false;
    for (var c = 0; c < endNode.data.length && !found; c++) {
        range.setStart(startNode, 0);
        range.setEnd(endNode, c);
        if (CountMatchesInRange(range, textToFind) == matchesRequired) {
            endPos = c;
            found = true;
        }
    }
    found = false;
    for (var startPos = startNode.data.length; startPos >= 0 && !found; startPos--) {
        range.setEnd(endNode, endPos);
        range.setStart(startNode, startPos);
        if (range.toString().indexOf(textToFind) != -1) {
            found = true;
        }
    }

    HighlightRange(range, cssClass, claimId, infoText, allowRemove);
    return true;
}

function HighlightSimpleRange(range, cssClass, claimId, infoText, allowRemove) {
    if ("[object Comment]" == range.startContainer + "") return;

    var newNode = document.createElement("FishBarrelHLSpan");
    var safeId = "HL_" + claimId + "_";
    var c = 1;
    while (document.getElementById(safeId + c)) c++;
    safeId += "" + c;

    newNode.id = safeId;
    newNode.setAttribute("title", infoText);
    newNode.setAttribute("class", cssClass);

    try {
        range.surroundContents(newNode);
    } catch (e) {
        return;
    }

    var newEl = document.getElementById(safeId);
    if (!newEl) return;

    if (allowRemove) {
        newEl.addEventListener("click", function () { FishBarrel.Kill(this); });
    }
    newEl.claimId = claimId;
}

var startPointAncestors = [];
var endPointAncestors = [];

function HighlightRange(range, cssClass, claimId, infoText, allowRemove) {
    if (range.startContainer == range.endContainer) {
        HighlightSimpleRange(range, cssClass, claimId, infoText, allowRemove);
        return;
    }

    var firstRange = document.createRange();
    firstRange.setStart(range.startContainer, range.startOffset);
    firstRange.setEnd(range.startContainer, range.startContainer.length);

    var endRange = document.createRange();
    endRange.setStart(range.endContainer, 0);
    endRange.setEnd(range.endContainer, range.endOffset);

    var commonAncestor = range.commonAncestorContainer;
    var nodesToHighlight = [];

    startPointAncestors = [];
    endPointAncestors = [];

    var tmp = range.startContainer;
    while (tmp != commonAncestor) {
        startPointAncestors.push(tmp);
        tmp = tmp.parentNode;
    }

    tmp = range.endContainer.parentNode;
    while (tmp != commonAncestor) {
        endPointAncestors.push(tmp);
        tmp = tmp.parentNode;
    }

    function isEndAncestor(node) {
        for (var a = 0; a < endPointAncestors.length; a++) {
            if (endPointAncestors[a] == node) return true;
        }
        return false;
    }
    function isStartAncestor(node) {
        for (var a = 0; a < startPointAncestors.length; a++) {
            if (startPointAncestors[a] == node) return true;
        }
        return false;
    }

    function HighlightRecursive(node) {
        nodesToHighlight.push(node);
        for (var c = 0; c < node.childNodes.length; c++) {
            HighlightRecursive(node.childNodes[c]);
        }
    }

    var node = range.startContainer;
    var endContainer = range.endContainer;
    var count = 0;
    while ((node != commonAncestor) && (count < 300) && (node != endContainer)) {
        count++;
        if (isStartAncestor(node)) {
            node = node.nextSibling != null ? node.nextSibling : node.parentNode;
        } else if (isEndAncestor(node)) {
            node = node.childNodes[0];
        } else if (!nodeIsInTableOutsideTd(node)) {
            if (range.endContainer != node) HighlightRecursive(node);
            node = node.nextSibling != null ? node.nextSibling : node.parentNode;
        } else {
            var moved = false;
            if (node.childNodes.length > 0 && !node.beenToChild) {
                node.beenToChild = true;
                node = node.childNodes[0];
                moved = true;
            }
            if (!moved) {
                node = node.nextSibling != null ? node.nextSibling : node.parentNode;
            }
        }
    }

    for (var i = 0; i < nodesToHighlight.length; i++) {
        var n = nodesToHighlight[i];
        var tr = document.createRange();
        tr.setStart(n, 0);
        var len = n.length ? n.length : n.childNodes.length;
        tr.setEnd(n, len);
        HighlightSimpleRange(tr, cssClass, claimId, infoText, allowRemove);
    }

    HighlightSimpleRange(firstRange, cssClass, claimId, infoText, allowRemove);
    HighlightSimpleRange(endRange, cssClass, claimId, infoText, allowRemove);
}

function nodeIsInTableOutsideTd(node) {
    var tmpNode = node;
    while (tmpNode) {
        if (tmpNode.tagName == "LI") return false;
        if (tmpNode.tagName == "TD") return false;
        if (tmpNode.tagName == "UL") return true;
        if (tmpNode.tagName == "OL") return true;
        if (tmpNode.tagName == "TABLE") return true;
        tmpNode = tmpNode.parentNode;
    }
    return false;
}

function CountMatches(stringToSearch, match) {
    var index = 0;
    var count = 0;
    var thisIndex = stringToSearch.indexOf(match, index);
    index = thisIndex + match.length;
    while (thisIndex != -1) {
        count++;
        thisIndex = stringToSearch.indexOf(match, index);
        index = thisIndex + match.length;
    }
    return count;
}

function CountMatchesInRange(range, match) {
    return CountMatches(range.toString(), match);
}

function WhichInstanceOfTextIsSelected() {
    var selRange = window.getSelection().getRangeAt(0);
    var selectedText = selRange.toString();
    selRange.setStart(document.body, 0);
    return CountMatchesInRange(selRange, selectedText);
}
