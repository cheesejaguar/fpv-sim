// The WKWebView that runs the simulator core, and the two-way bridge to the page
// (src/visionos/nativeHost.ts): messages in through the "fpvNative" handler, calls out through
// window.__fpvNative.
import SwiftUI
import WebKit

@MainActor
final class WebHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    var onMessage: (([String: Any]) -> Void)?
    var onLoadFailed: ((String) -> Void)?

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default() // settings and the Betaflight EEPROM persist between launches
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.configuration.userContentController.add(self, name: "fpvNative")
        webView.navigationDelegate = self
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.14, alpha: 1)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.isInspectable = true
    }

    func load(port: UInt16) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/index.html") else { return }
        webView.load(URLRequest(url: url))
    }

    /// Call a function of window.__fpvNative (ignored until the page has installed it).
    func call(_ function: String, _ args: String = "") {
        webView.evaluateJavaScript("window.__fpvNative&&window.__fpvNative.\(function)(\(args))", completionHandler: nil)
    }

    /// Whether the page got the cross-origin isolation the simulator's shared memory needs.
    func checkIsolation(_ done: @escaping (Bool) -> Void) {
        webView.evaluateJavaScript("self.crossOriginIsolated === true") { value, _ in done((value as? Bool) ?? false) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        onMessage?(body)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onLoadFailed?(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onLoadFailed?(error.localizedDescription)
    }

    /// Links out of the simulator (GitHub, licences) don't open: the app is offline by design.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let host = navigationAction.request.url?.host
        let scheme = navigationAction.request.url?.scheme ?? ""
        let local = host == "127.0.0.1" || scheme == "blob" || scheme == "about" || scheme == "data"
        decisionHandler(local ? .allow : .cancel)
    }
}

struct WebView: UIViewRepresentable {
    let host: WebHost
    func makeUIView(context: Context) -> WKWebView { host.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
