(function () {
  "use strict";

  var SUBJECT_FALLBACK = "No subject available";
  var SENDER_FALLBACK = "Sender unavailable";
  var MODE_FALLBACK = "General";

  var elements = {};

  document.addEventListener("DOMContentLoaded", function () {
    elements.statusBadge = document.getElementById("status-badge");
    elements.mode = document.getElementById("context-mode");
    elements.subject = document.getElementById("context-subject");
    elements.sender = document.getElementById("context-sender");
    elements.destination = document.getElementById("destination-url");
    elements.openLink = document.getElementById("open-app-link");
    elements.refreshButton = document.getElementById("refresh-button");
    elements.contextNote = document.getElementById("context-note");

    elements.refreshButton.addEventListener("click", function () {
      refreshContext();
    });

    elements.openLink.addEventListener("click", function (event) {
      var targetUrl = elements.openLink.getAttribute("href");
      if (!targetUrl) {
        return;
      }

      if (window.Office && Office.context && Office.context.ui && typeof Office.context.ui.openBrowserWindow === "function") {
        event.preventDefault();
        Office.context.ui.openBrowserWindow(targetUrl);
      }
    });

    setStatus("Loading Outlook", "pending");
    renderContext({
      modeLabel: inferHostContextLabel(),
      subject: SUBJECT_FALLBACK,
      senderLabel: SENDER_FALLBACK
    });

    initializeOffice();
  });

  function initializeOffice() {
    if (!window.Office || typeof Office.onReady !== "function") {
      setStatus("Office.js unavailable", "warning");
      elements.contextNote.textContent = "Office.js did not initialize. Open this pane from Outlook to load live item context.";
      refreshContext();
      return;
    }

    Office.onReady()
      .then(function (info) {
        if (!info || info.host !== Office.HostType.Outlook) {
          setStatus("Not running in Outlook", "warning");
          elements.contextNote.textContent = "This shell is designed for Outlook. Context fields will stay in fallback mode outside that host.";
          refreshContext();
          return;
        }

        setStatus("Connected to Outlook", "ready");
        registerItemChangedHandler();
        refreshContext();
      })
      .catch(function () {
        setStatus("Outlook unavailable", "warning");
        elements.contextNote.textContent = "Outlook did not finish initializing, so only the hosted-app link is available.";
        refreshContext();
      });
  }

  function registerItemChangedHandler() {
    if (!Office.context || !Office.context.mailbox || typeof Office.context.mailbox.addHandlerAsync !== "function") {
      return;
    }

    if (!Office.EventType || !Office.EventType.ItemChanged) {
      return;
    }

    Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, function () {
      refreshContext();
    });
  }

  function refreshContext() {
    var item = getCurrentItem();
    var context = {
      modeLabel: inferModeLabel(item),
      subject: readSubject(item),
      sender: readSender(item)
    };
    context.senderLabel = formatSender(context.sender);
    context.appUrl = buildHostedAppUrl(context);
    renderContext(context);
  }

  function getCurrentItem() {
    if (!window.Office || !Office.context || !Office.context.mailbox) {
      return null;
    }

    return Office.context.mailbox.item || null;
  }

  function inferModeLabel(item) {
    var fromQuery = inferHostContextLabel();
    if (fromQuery !== MODE_FALLBACK) {
      return fromQuery;
    }

    if (!item) {
      return MODE_FALLBACK;
    }

    if (typeof item.itemId === "string" && item.itemId) {
      return "Message read";
    }

    return "Message compose";
  }

  function inferHostContextLabel() {
    var params = new URLSearchParams(window.location.search);
    var hostContext = (params.get("hostContext") || "").toLowerCase();

    if (hostContext === "read") {
      return "Message read";
    }

    if (hostContext === "compose") {
      return "Message compose";
    }

    return MODE_FALLBACK;
  }

  function readSubject(item) {
    if (!item || typeof item.subject !== "string") {
      return SUBJECT_FALLBACK;
    }

    var subject = item.subject.trim();
    return subject || SUBJECT_FALLBACK;
  }

  function readSender(item) {
    if (!item) {
      return null;
    }

    var sender = item.from || item.sender || item.organizer || null;
    if (sender && (sender.displayName || sender.emailAddress)) {
      return sender;
    }

    return null;
  }

  function formatSender(sender) {
    if (!sender) {
      return SENDER_FALLBACK;
    }

    var displayName = normalizeText(sender.displayName);
    var emailAddress = normalizeText(sender.emailAddress);

    if (displayName && emailAddress) {
      return displayName + " <" + emailAddress + ">";
    }

    return displayName || emailAddress || SENDER_FALLBACK;
  }

  function buildHostedAppUrl(context) {
    var config = readConfig();
    var baseUrl = resolveBaseUrl(config.appRoot);
    var url = new URL(normalizeAppPath(config.appPath), baseUrl);

    url.searchParams.set("source", "outlook-addin");
    url.searchParams.set("hostContext", (new URLSearchParams(window.location.search).get("hostContext") || "general").toLowerCase());

    if (context.subject && context.subject !== SUBJECT_FALLBACK) {
      url.searchParams.set("subject", context.subject);
    }

    if (context.sender) {
      if (normalizeText(context.sender.displayName)) {
        url.searchParams.set("senderName", normalizeText(context.sender.displayName));
      }

      if (normalizeText(context.sender.emailAddress)) {
        url.searchParams.set("senderEmail", normalizeText(context.sender.emailAddress));
      }
    }

    return url;
  }

  function readConfig() {
    var params = new URLSearchParams(window.location.search);
    return {
      appRoot: params.get("appRoot") || readMeta("addin-app-root", "current"),
      appPath: params.get("appPath") || readMeta("addin-app-path", "/")
    };
  }

  function readMeta(name, fallback) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    if (!meta) {
      return fallback;
    }

    return meta.getAttribute("content") || fallback;
  }

  function resolveBaseUrl(appRoot) {
    if (!appRoot || appRoot === "current") {
      return new URL(window.location.origin + "/");
    }

    try {
      var resolved = new URL(appRoot, window.location.origin + "/");
      return new URL(ensureTrailingSlash(resolved.href));
    } catch (_error) {
      return new URL(window.location.origin + "/");
    }
  }

  function ensureTrailingSlash(value) {
    return value.endsWith("/") ? value : value + "/";
  }

  function normalizeText(value) {
    if (typeof value !== "string") {
      return "";
    }

    return value.trim();
  }

  function normalizeAppPath(value) {
    var appPath = normalizeText(value);
    if (!appPath || appPath === "/") {
      return "";
    }

    if (/^https?:\/\//i.test(appPath)) {
      return appPath;
    }

    return appPath.replace(/^\/+/, "");
  }

  function renderContext(context) {
    elements.mode.textContent = context.modeLabel || MODE_FALLBACK;
    elements.subject.textContent = context.subject || SUBJECT_FALLBACK;
    elements.sender.textContent = context.senderLabel || SENDER_FALLBACK;

    if (context.appUrl) {
      var href = context.appUrl.toString();
      elements.openLink.setAttribute("href", href);
      elements.destination.textContent = href;
    }
  }

  function setStatus(text, tone) {
    elements.statusBadge.textContent = text;
    elements.statusBadge.className = "status-badge status-" + tone;
  }
})();
