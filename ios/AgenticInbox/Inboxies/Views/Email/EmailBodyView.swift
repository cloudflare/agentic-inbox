import SwiftUI
import WebKit

/// Renders HTML email bodies; falls back to plain text when needed.
struct EmailBodyView: View {
    let htmlOrText: String

    private var isHTML: Bool {
        htmlOrText.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil
    }

    var body: some View {
        if isHTML {
            HTMLWebView(html: wrappedHTML)
                .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 480, alignment: .top)
        } else {
            Text(htmlOrText)
                .font(.system(size: 16))
                .foregroundStyle(AppTheme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }

    private var wrappedHTML: String {
        """
        <!DOCTYPE html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
          :root { color-scheme: light; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 16px;
            line-height: 1.45;
            color: #1f1f23;
            margin: 0;
            padding: 0;
            word-wrap: break-word;
            overflow-wrap: anywhere;
          }
          img { max-width: 100%; height: auto; }
          a { color: #2659d9; }
          pre, code { white-space: pre-wrap; }
        </style>
        </head>
        <body>\(htmlOrText)</body>
        </html>
        """
    }
}

private struct HTMLWebView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = true
        webView.scrollView.backgroundColor = .clear
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(html, baseURL: nil)
    }
}
