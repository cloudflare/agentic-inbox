import SwiftUI
import WebKit

/// Renders HTML email bodies; falls back to plain text when needed.
/// Inline `cid:` images are fetched via the attachment API and inlined as data URIs
/// (web does the same rewrite in `rewriteInlineImages`).
struct EmailBodyView: View {
    let htmlOrText: String
    var mailboxId: String?
    var emailId: String?
    var attachments: [Attachment] = []

    @State private var htmlWithImages: String?
    @State private var webHeight: CGFloat = 1

    private var isHTML: Bool {
        htmlOrText.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil
    }

    private var bodyHTML: String {
        htmlWithImages ?? htmlOrText
    }

    var body: some View {
        Group {
            if isHTML {
                HTMLWebView(html: wrappedHTML, contentHeight: $webHeight)
                    .frame(maxWidth: .infinity, alignment: .top)
                    .frame(height: webHeight)
            } else {
                Text(htmlOrText)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .task(id: resolveTaskID) {
            await resolveInlineImages()
        }
    }

    private var resolveTaskID: String {
        "\(emailId ?? "")|\(htmlOrText.count)|\(attachments.map(\.id).joined(separator: ","))"
    }

    private var wrappedHTML: String {
        """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
          :root { color-scheme: light; }
          html, body {
            margin: 0;
            padding: 0;
            overflow: visible;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: \(Int(AppTheme.FontSize.body))px;
            line-height: 1.45;
            color: #1f1f23;
            word-wrap: break-word;
            overflow-wrap: anywhere;
          }
          img { max-width: 100%; height: auto; }
          a { color: #2659d9; }
          pre, code { white-space: pre-wrap; }
        </style>
        </head>
        <body>\(bodyHTML)
        <script>
          function postHeight() {
            const h = Math.max(
              document.body.scrollHeight,
              document.documentElement.scrollHeight
            );
            if (window.webkit && window.webkit.messageHandlers.bodyHeight) {
              window.webkit.messageHandlers.bodyHeight.postMessage(h);
            }
          }
          window.addEventListener('load', postHeight);
          window.addEventListener('resize', postHeight);
          document.querySelectorAll('img').forEach(function (img) {
            img.addEventListener('load', postHeight);
            img.addEventListener('error', postHeight);
          });
          if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(postHeight).observe(document.body);
          }
          postHeight();
        </script>
        </body>
        </html>
        """
    }

    @MainActor
    private func resolveInlineImages() async {
        htmlWithImages = nil
        guard isHTML, let mailboxId, let emailId else { return }

        let targets = attachments.filter { $0.normalizedContentId != nil }
        guard !targets.isEmpty else { return }

        var replacements: [String: String] = [:]
        await withTaskGroup(of: (String, String)?.self) { group in
            for attachment in targets {
                guard let cid = attachment.normalizedContentId else { continue }
                group.addTask {
                    do {
                        let data = try await APIClient.shared.getAttachment(
                            mailboxId: mailboxId,
                            emailId: emailId,
                            attachmentId: attachment.id
                        )
                        let mime = attachment.mimetype.isEmpty
                            ? "application/octet-stream"
                            : attachment.mimetype
                        return (cid, "data:\(mime);base64,\(data.base64EncodedString())")
                    } catch {
                        return nil
                    }
                }
            }
            for await item in group {
                if let (cid, uri) = item {
                    replacements[cid] = uri
                }
            }
        }

        guard !Task.isCancelled, !replacements.isEmpty else { return }
        var next = htmlOrText
        for (cid, uri) in replacements {
            next = Self.replaceCID(cid, in: next, with: uri)
        }
        guard next != htmlOrText else { return }
        htmlWithImages = next
    }

    /// Mirrors web `rewriteInlineImages`: swap `cid:image001@example.com` for a loadable URL.
    static func replaceCID(_ cid: String, in html: String, with replacement: String) -> String {
        var result = html.replacingOccurrences(
            of: "cid:\(cid)",
            with: replacement,
            options: .caseInsensitive
        )
        result = result.replacingOccurrences(
            of: "cid:<\(cid)>",
            with: replacement,
            options: .caseInsensitive
        )
        return result
    }
}

private struct HTMLWebView: UIViewRepresentable {
    let html: String
    @Binding var contentHeight: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $contentHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "bodyHeight")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.height = $contentHeight
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        // A real https origin lets remote images load. Do not use the API host —
        // email HTML is unsanitized and must not be same-origin with the backend.
        webView.loadHTMLString(html, baseURL: URL(string: "https://inboxies.invalid/"))
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "bodyHeight")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var height: Binding<CGFloat>
        var loadedHTML: String?

        init(height: Binding<CGFloat>) {
            self.height = height
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "bodyHeight" else { return }
            applyHeight(message.body)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript(
                "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)"
            ) { [weak self] result, _ in
                self?.applyHeight(result)
            }
        }

        private func applyHeight(_ raw: Any?) {
            let measured: CGFloat
            if let number = raw as? Double {
                measured = CGFloat(number)
            } else if let number = raw as? CGFloat {
                measured = number
            } else if let number = raw as? Int {
                measured = CGFloat(number)
            } else {
                return
            }
            let next = max(measured.rounded(.up), 1)
            DispatchQueue.main.async {
                if abs(self.height.wrappedValue - next) > 1 {
                    self.height.wrappedValue = next
                }
            }
        }
    }
}
