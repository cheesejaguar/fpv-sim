// A tiny HTTP/1.1 server on the loopback interface. It serves the bundled web build (the simulator
// core: Betaflight / ArduPilot WebAssembly, physics, menus) to the app's own WKWebView and takes the
// scene blobs the page posts back. Nothing leaves the device: it listens on 127.0.0.1 only.
//
// Why a server and not file:// or a custom URL scheme: the simulator shares memory between the page
// and its physics worker (SharedArrayBuffer), which WebKit only allows on a cross-origin isolated
// page, i.e. one served with the COOP / COEP headers below from a secure origin. Loopback HTTP is one.
import Foundation
import Network

final class LocalServer: @unchecked Sendable {
    typealias Upload = @Sendable (_ path: String, _ query: [String: String], _ body: Data) -> Void

    /// The page's storage (settings, the Betaflight EEPROM, lap records) belongs to its origin, port
    /// included: the port must stay the same from launch to launch.
    static let preferredPort: UInt16 = 51730

    private let root: URL
    private let queue = DispatchQueue(label: "fpvsim.server")
    private var listener: NWListener?
    var onUpload: Upload?

    init(root: URL) { self.root = root.standardizedFileURL }

    func start() async throws -> UInt16 {
        do { return try await listen(on: Self.preferredPort) } catch { return try await listen(on: 0) }
    }

    func stop() { listener?.cancel(); listener = nil }

    private func listen(on port: UInt16) async throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port) ?? .any)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            var done = false
            l.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if !done { done = true; self?.listener = l; cont.resume(returning: l.port?.rawValue ?? port) }
                case .failed(let e):
                    if !done { done = true; l.cancel(); cont.resume(throwing: e) }
                case .cancelled:
                    if !done { done = true; cont.resume(throwing: CancellationError()) }
                default: break
                }
            }
            l.start(queue: self.queue)
        }
    }

    // MARK: connections

    private final class Conn {
        let c: NWConnection
        var buf = Data()
        init(_ c: NWConnection) { self.c = c }
    }

    private func accept(_ c: NWConnection) {
        let conn = Conn(c)
        c.start(queue: queue)
        read(conn)
    }

    private func read(_ conn: Conn) {
        conn.c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, eof, err in
            guard let self else { return }
            if let data { conn.buf.append(data) }
            if err != nil { conn.c.cancel(); return }
            self.drain(conn)
            if eof { conn.c.send(content: nil, isComplete: true, completion: .contentProcessed { _ in conn.c.cancel() }); return }
            self.read(conn)
        }
    }

    private static let headEnd = Data("\r\n\r\n".utf8)
    private static let maxBody = 256 << 20

    /// Answer every complete request in the buffer (the page keeps its connections open).
    private func drain(_ conn: Conn) {
        while let r = conn.buf.range(of: Self.headEnd) {
            guard let head = String(data: conn.buf.subdata(in: conn.buf.startIndex..<r.lowerBound), encoding: .utf8) else { conn.c.cancel(); return }
            var lines = head.components(separatedBy: "\r\n")
            let request = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
            guard request.count >= 2 else { conn.c.cancel(); return }
            var length = 0
            for l in lines {
                guard let i = l.firstIndex(of: ":") else { continue }
                if l[..<i].lowercased() == "content-length" { length = Int(l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)) ?? 0 }
            }
            guard length >= 0, length <= Self.maxBody else { conn.c.cancel(); return }
            guard conn.buf.endIndex - r.upperBound >= length else { return } // the body is still arriving
            let body = conn.buf.subdata(in: r.upperBound..<(r.upperBound + length))
            conn.buf = Data(conn.buf[(r.upperBound + length)...])
            respond(conn, method: String(request[0]), target: String(request[1]), body: body)
        }
    }

    private func respond(_ conn: Conn, method: String, target: String, body: Data) {
        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let rawPath = parts.first.map(String.init) ?? "/"
        let path = rawPath.removingPercentEncoding ?? rawPath
        var query: [String: String] = [:]
        if parts.count > 1 {
            for kv in parts[1].split(separator: "&") {
                let p = kv.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                if let k = p.first { query[String(k)] = p.count > 1 ? (String(p[1]).removingPercentEncoding ?? String(p[1])) : "" }
            }
        }
        switch method {
        case "POST":
            guard path.hasPrefix("/__native/") else { send(conn, 404, "text/plain", Data("not found".utf8)); return }
            onUpload?(path, query, body)
            send(conn, 200, "text/plain", Data("ok".utf8))
        case "GET", "HEAD":
            guard let (data, mime) = file(at: path) else { send(conn, 404, "text/plain", Data("not found".utf8), head: method == "HEAD"); return }
            send(conn, 200, mime, data, head: method == "HEAD")
        default:
            send(conn, 405, "text/plain", Data("method not allowed".utf8))
        }
    }

    private func file(at path: String) -> (Data, String)? {
        var rel = path
        while rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "index.html" }
        if rel.split(separator: "/").contains(where: { $0 == ".." }) { return nil }
        var url = root.appendingPathComponent(rel).standardizedFileURL
        guard url.path == root.path || url.path.hasPrefix(root.path + "/") else { return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return nil }
        if isDir.boolValue { url = url.appendingPathComponent("index.html") }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        return (data, Self.mime(url.pathExtension.lowercased()))
    }

    private static func mime(_ ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "glb": return "model/gltf-binary"
        case "gltf": return "model/gltf+json"
        case "txt", "md", "mcm", "map", "lua", "csv": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    /// The page may load and connect to this origin only: no request can leave the device.
    private static let csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; media-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

    private func send(_ conn: Conn, _ status: Int, _ mime: String, _ body: Data, head: Bool = false) {
        let reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Error"
        var h = "HTTP/1.1 \(status) \(reason)\r\n"
        h += "Content-Type: \(mime)\r\n"
        h += "Content-Length: \(body.count)\r\n"
        h += "Connection: keep-alive\r\n"
        h += "Cache-Control: no-cache\r\n"
        h += "Cross-Origin-Opener-Policy: same-origin\r\n"
        h += "Cross-Origin-Embedder-Policy: require-corp\r\n"
        h += "Cross-Origin-Resource-Policy: same-origin\r\n"
        h += "X-Content-Type-Options: nosniff\r\n"
        h += "Content-Security-Policy: \(Self.csp)\r\n"
        h += "\r\n"
        var out = Data(h.utf8)
        if !head { out.append(body) }
        conn.c.send(content: out, completion: .contentProcessed { _ in })
    }
}
