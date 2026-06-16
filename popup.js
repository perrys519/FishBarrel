document.addEventListener('DOMContentLoaded', async function () {
    var state = await sendBg({ type: "getState" });
    if (!state) state = { isCollecting: false, groupExists: false, statusText: "Inactive", currentUrl: "" };

    var statusBlock = document.getElementById("StatusBlock");
    var statusPill = document.getElementById("StatusText");
    statusPill.innerText = state.isCollecting ? "Capturing" : "Inactive";
    if (state.isCollecting) statusBlock.classList.add("fb-active");

    var startEl = document.getElementById("Start");
    var stopEl = document.getElementById("Stop");
    var reviewEl = document.getElementById("ReviewComplaint");
    var resumeEl = document.getElementById("Resume");

    // Primary action swaps: when not capturing, "Capture new claims" is primary;
    // when capturing, "Review complaint" is the natural next step.
    if (state.isCollecting) {
        startEl.classList.add("disabled");
        startEl.classList.remove("fb-action-primary");
        stopEl.classList.remove("disabled");
        if (state.groupExists) reviewEl.classList.add("fb-action-primary");
    } else {
        stopEl.classList.add("disabled");
    }
    if (!state.groupExists) reviewEl.classList.add("disabled");

    if (!state.currentUrl || state.currentUrl.length < 7) {
        resumeEl.style.display = "none";
    } else {
        document.getElementById("resumeDescription").innerText = state.currentUrl.substring(7);
    }

    startEl.addEventListener('click', async function (e) {
        e.preventDefault();
        if (this.classList.contains("disabled")) return;
        await sendBg({ type: "init" });
        window.close();
    });

    resumeEl.addEventListener('click', async function (e) {
        e.preventDefault();
        if (this.classList.contains("disabled")) return;
        await sendBg({ type: "resume" });
        window.close();
    });

    stopEl.addEventListener('click', async function (e) {
        e.preventDefault();
        if (this.classList.contains("disabled")) return;
        await sendBg({ type: "endCapture" });
        window.close();
    });

    reviewEl.addEventListener('click', function (e) {
        if (this.classList.contains("disabled")) {
            e.preventDefault();
        }
    });

    document.getElementById("Options").addEventListener('click', function (e) {
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
        window.close();
    });

    document.getElementById("Help").addEventListener('click', function (e) {
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
        window.close();
    });
});
