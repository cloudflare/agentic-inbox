(function () {
  "use strict";
  var status = document.getElementById("status");
  var subject = document.getElementById("subject");
  var sender = document.getElementById("sender");
  var open = document.getElementById("open");

  function refresh() {
    var item = window.Office && Office.context && Office.context.mailbox && Office.context.mailbox.item;
    var title = item && typeof item.subject === "string" ? item.subject.trim() : "No subject available";
    var from = item && (item.from || item.sender);
    var senderText = from && (from.displayName || from.emailAddress) ? (from.displayName || from.emailAddress) : "Sender unavailable";
    subject.textContent = title || "No subject available";
    sender.textContent = senderText;
    status.textContent = item ? "Context loaded. Open the briefing to act." : "Open this pane from an Outlook message.";
    var url = new URL("/", window.location.origin);
    url.searchParams.set("source", "outlook-addin");
    if (title && title !== "No subject available") url.searchParams.set("subject", title);
    open.href = url.toString();
  }

  if (window.Office && typeof Office.onReady === "function") {
    Office.onReady(function () {
      refresh();
      if (Office.context.mailbox && Office.context.mailbox.addHandlerAsync) {
        Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, refresh);
      }
    });
  } else {
    status.textContent = "Office.js unavailable. Open this page inside Outlook.";
    refresh();
  }
}());
