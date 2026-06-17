document.addEventListener('DOMContentLoaded', async function () {
    var state = await sendBg({ type: "getState" });
    if (!state) state = { isCollecting: false, groupExists: false, statusText: "Inactive", currentUrl: "", spider: { active: false } };

    var statusBlock = document.getElementById("StatusBlock");
    var statusPill = document.getElementById("StatusText");
    var spiderActive = !!(state.spider && state.spider.active);
    if (spiderActive) {
        statusPill.innerText = "Spidering " + (state.spider.pagesScanned || 0) + "/" + (state.spider.maxPages || 0);
        statusBlock.classList.add("fb-active");
    } else {
        statusPill.innerText = state.isCollecting ? "Capturing" : "Inactive";
        if (state.isCollecting) statusBlock.classList.add("fb-active");
    }

    var startEl = document.getElementById("Start");
    var stopEl = document.getElementById("Stop");
    var reviewEl = document.getElementById("ReviewComplaint");
    var resumeEl = document.getElementById("Resume");
    var crawlEl = document.getElementById("CrawlSite");
    var crawlDesc = document.getElementById("crawlSiteDescription");

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

    if (spiderActive) {
        crawlEl.classList.add("disabled");
        if (crawlDesc) crawlDesc.innerText = "Crawling " + state.spider.rootHost + " (" + state.spider.pagesScanned + "/" + state.spider.maxPages + ", " + state.spider.queueRemaining + " queued)";
    }

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

    crawlEl.addEventListener('click', async function (e) {
        e.preventDefault();
        if (this.classList.contains("disabled")) return;

        // Resolve the current tab's URL and hand it to the background spider.
        chrome.tabs.query({ active: true, currentWindow: true }, async function (tabs) {
            if (!tabs || !tabs[0] || !tabs[0].url) {
                window.close();
                return;
            }
            var url = tabs[0].url;
            if (!/^https?:/i.test(url)) {
                alert("FishBarrel can only crawl http(s) pages. Open a normal web page first.");
                return;
            }
            var result = await sendBg({ type: "spiderStart", url: url });
            if (result && result.error === "already-running") {
                // Treat second click as a stop request.
                await sendBg({ type: "spiderStop" });
            }
            window.close();
        });
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
