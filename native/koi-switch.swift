// koi-switch: Koi's window switcher helper for macOS (Koi 2.1).
//
// A tiny command-line process that Koi starts from Koi.app/Contents/MacOS/koi-switch. It talks to Koi over
// stdin/stdout, one JSON object per line, and does the four things Electron cannot:
//   1. an event tap (kCGSessionEventTap, head insert) that CONSUMES Cmd+Tab and Cmd+Shift+Tab, so Apple's own
//      switcher never appears, plus the keys Koi's switcher uses while it is open (arrows, Esc, Q, W, Return);
//   2. a window list across all apps (CGWindowListCopyWindowInfo, mapped to AXUIElement windows through the AX API);
//   3. window thumbnails (ScreenCaptureKit SCScreenshotManager on macOS 14+, CGWindowListCreateImage before that);
//   4. raising and focusing one exact window (un-minimizing it if needed).
//
// Safety: Cmd+Tab must never end up dead. Apple's Cmd+Tab symbolic hotkeys are only switched off while this
// process runs with a healthy tap, and are switched back on when: the tap fails or keeps timing out, Koi stops
// answering (no ack within a second), Koi closes stdin (Koi quit or crashed), a signal arrives, or the process
// exits. Koi also runs `koi-switch --restore` whenever this helper dies unexpectedly.
//
// Idle cost: none. No timers or polling while the switcher is closed; the only thing alive is the event tap.
// (The one exception: while Accessibility is missing, the tap is retried every few seconds until it works.)
//
// CLI:  koi-switch [--cache DIR] [--parent PID]    run the helper (Koi does this)
//       koi-switch --selftest                       list windows without any permission, print JSON, exit 0
//       koi-switch --restore                        switch Apple's Cmd+Tab back on, exit
//       koi-switch --perm                           print {"ax":bool,"screen":bool}, exit
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

let PROTOCOL = 1

// MARK: - output (thread safe, never throws on a closed pipe)

let outQ = DispatchQueue(label: "koi.switch.out")
func writeLine(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let d = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    var bytes = [UInt8](d)
    bytes.append(10)
    bytes.withUnsafeBufferPointer { p in
        var off = 0
        while off < p.count {
            let n = write(1, p.baseAddress! + off, p.count - off)
            if n <= 0 { return }
            off += n
        }
    }
}
func emit(_ obj: [String: Any]) { outQ.async { writeLine(obj) } }

// MARK: - private symbols, looked up at run time (missing ones only turn a feature off, never break the build)

let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
func sym<T>(_ name: String, _ type: T.Type) -> T? {
    var p: UnsafeMutableRawPointer? = nil
    if let h = skyLight { p = dlsym(h, name) }
    if p == nil { p = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) }   // RTLD_DEFAULT
    guard let fp = p else { return nil }
    return unsafeBitCast(fp, to: type)
}
typealias SetSymbolicHotKeyFn = @convention(c) (Int32, Bool) -> Int32
typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> Int32
typealias GetPSNFn = @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
typealias SetFrontFn = @convention(c) (UnsafeMutableRawPointer, UInt32, UInt32) -> Int32
typealias PostEventRecordFn = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
typealias CGWindowImageFn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

let setSymbolicHotKey = sym("CGSSetSymbolicHotKeyEnabled", SetSymbolicHotKeyFn.self)
let axGetWindow = sym("_AXUIElementGetWindow", AXGetWindowFn.self)
let getPSN = sym("GetProcessForPID", GetPSNFn.self)
let setFrontProcess = sym("_SLPSSetFrontProcessWithOptions", SetFrontFn.self)
let postEventRecord = sym("SLPSPostEventRecordTo", PostEventRecordFn.self)
let cgWindowImage = sym("CGWindowListCreateImage", CGWindowImageFn.self)

// MARK: - Apple's Cmd+Tab (symbolic hotkeys 1 = Cmd+Tab, 2 = Cmd+Shift+Tab)

let NATIVE_KEYS: [Int32] = [1, 2]
var nativeOff = false
func setNative(enabled: Bool) {
    guard let f = setSymbolicHotKey else { return }
    for k in NATIVE_KEYS { _ = f(k, enabled) }
    nativeOff = !enabled
}
// async-signal context: only calls the C function, no Swift allocation
func restoreNativeNow() {
    guard let f = setSymbolicHotKey else { return }
    _ = f(1, true)
    _ = f(2, true)
}

// MARK: - state (touched on the main thread only: the tap callback and command handlers both run there)

var cacheDir = NSTemporaryDirectory() + "koi-switch"
var parentPid: Int32 = 0
var tap: CFMachPort? = nil
var tapState = "off"          // off | on | noperm | failed
var enabled = true            // the switcher is on in Koi's settings
var replace = true            // Cmd+Tab (true) or Option+Tab (false, Apple keeps Cmd+Tab)
var trigger: CGEventFlags = .maskCommand
var trigDown = false
var active = false            // Koi's switcher is open for this gesture
var bypass = false            // Koi did not answer in time: let macOS have Cmd+Tab until it does
var seq = 0
var ackItem: DispatchWorkItem? = nil
var swallowUp = Set<Int64>()  // keys whose key-down we consumed: consume their key-up too
var timeouts: [Date] = []
var lastWarm = Date.distantPast
var retryTimer: DispatchSourceTimer? = nil
var retryN = 0

let KC_TAB: Int64 = 48, KC_ESC: Int64 = 53, KC_LEFT: Int64 = 123, KC_RIGHT: Int64 = 124, KC_DOWN: Int64 = 125,
    KC_UP: Int64 = 126, KC_Q: Int64 = 12, KC_W: Int64 = 13, KC_RETURN: Int64 = 36, KC_ENTER: Int64 = 76, KC_GRAVE: Int64 = 50
let ACTIVE_KEYS: [Int64: String] = [KC_ESC: "esc", KC_LEFT: "left", KC_RIGHT: "right", KC_UP: "up", KC_DOWN: "down",
                                    KC_Q: "q", KC_W: "w", KC_RETURN: "return", KC_ENTER: "return", KC_GRAVE: "grave"]

func wantNativeOff() -> Bool { return enabled && replace && tapState == "on" && !bypass }
func applyNative() { let off = wantNativeOff(); if off != nativeOff { setNative(enabled: !off) } }

// MARK: - the event tap

func tapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        tapTimedOut()
        return Unmanaged.passUnretained(event)
    }
    let flags = event.flags
    if type == .flagsChanged {
        let held = flags.contains(trigger)
        if !held && trigDown {
            trigDown = false
            if active { active = false; emit(["ev": "release"]) }
        } else if held && !trigDown {
            trigDown = true
            if enabled && Date().timeIntervalSince(lastWarm) > 1.0 { lastWarm = Date(); emit(["ev": "warm"]) }
        }
        return Unmanaged.passUnretained(event)          // modifiers always pass through
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    if type == .keyUp && swallowUp.contains(code) { swallowUp.remove(code); return nil }
    if !enabled || bypass || tapState != "on" { return Unmanaged.passUnretained(event) }
    let others: CGEventFlags = trigger == .maskCommand ? [.maskAlternate, .maskControl] : [.maskCommand, .maskControl]
    let modOK = flags.contains(trigger) && flags.intersection(others).isEmpty
    if code == KC_TAB && modOK {
        if type == .keyDown {
            let shift = flags.contains(.maskShift)
            if !active { active = true; openNow(shift: shift) } else { emit(["ev": shift ? "prev" : "next"]) }
            swallowUp.insert(code)
        }
        return nil
    }
    if active && flags.contains(trigger), let k = ACTIVE_KEYS[code] {
        if type == .keyDown {
            emit(["ev": "key", "k": k, "shift": flags.contains(.maskShift)])
            if k == "esc" { active = false }
            swallowUp.insert(code)
        }
        return nil
    }
    return Unmanaged.passUnretained(event)
}

func openNow(shift: Bool) {
    seq += 1
    if wantNativeOff() { setNative(enabled: false) }   // re-assert: an old helper (Koi updating) may have switched it back on
    let s = seq
    ackItem?.cancel()
    let item = DispatchWorkItem { koiSilent(s) }
    ackItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: item)
    listQ.async {
        let wins = listWindows(icons: true)
        emit(["ev": "open", "seq": s, "shift": shift, "windows": wins])
    }
}

// Koi did not ack the open within a second (hung, or busy): hand Cmd+Tab back to macOS until Koi answers again.
func koiSilent(_ s: Int) {
    guard s == seq, !bypass else { return }
    bypass = true
    active = false
    applyNative()
    emit(["ev": "tap", "state": "bypass"])
}

func tapTimedOut() {
    let now = Date()
    timeouts = timeouts.filter { now.timeIntervalSince($0) < 30 } + [now]
    if timeouts.count >= 4 {
        // macOS keeps switching the tap off: stop fighting it and give Cmd+Tab back to macOS
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        tapState = "failed"
        active = false
        applyNative()
        emit(["ev": "tap", "state": "failed", "why": "timeout"])
        return
    }
    if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
    // a key-up lost while the tap was off: if the trigger is no longer held, finish the gesture
    let f = CGEventSource.flagsState(.combinedSessionState)
    if !f.contains(trigger) {
        trigDown = false
        if active { active = false; emit(["ev": "release"]) }
    }
    emit(["ev": "tap", "state": "on", "reenabled": true])
}

func startTap() {
    if tap != nil { return }
    guard AXIsProcessTrusted() else {
        if tapState != "noperm" { tapState = "noperm"; emit(["ev": "tap", "state": "noperm"]) }
        scheduleTapRetry()
        return
    }
    let mask = (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue))
        | (CGEventMask(1) << CGEventMask(CGEventType.keyUp.rawValue))
        | (CGEventMask(1) << CGEventMask(CGEventType.flagsChanged.rawValue))
    guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                    eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else {
        tapState = "failed"
        emit(["ev": "tap", "state": "failed", "why": "create"])
        scheduleTapRetry()
        return
    }
    tap = t
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    tapState = "on"
    retryTimer?.cancel(); retryTimer = nil; retryN = 0
    applyNative()
    emit(["ev": "tap", "state": "on"])
}
// only while Accessibility is missing: every 2 s for a minute, then every 15 s
func scheduleTapRetry() {
    if retryTimer != nil { return }
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + (retryN < 30 ? 2 : 15))
    t.setEventHandler {
        retryTimer?.cancel(); retryTimer = nil; retryN += 1
        if tap == nil { startTap() }
    }
    retryTimer = t
    t.resume()
}

// MARK: - windows

let listQ = DispatchQueue(label: "koi.switch.list", qos: .userInteractive)
let axQ = DispatchQueue(label: "koi.switch.ax", qos: .userInteractive)
let thumbQ = DispatchQueue(label: "koi.switch.thumb", qos: .userInitiated)
var axWindows: [UInt32: AXUIElement] = [:]        // listQ / axQ: guarded by axLock
let axLock = NSLock()
var iconsWritten = Set<String>()                  // listQ only

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: CFTypeRef? = nil
    let e = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return e == .success ? v : nil
}
struct AXInfo { var title: String; var minimized: Bool; var subrole: String }
func axWindowsOf(_ pid: Int32) -> [UInt32: AXInfo]? {
    guard AXIsProcessTrusted(), let getWin = axGetWindow else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.15)          // a hung app must never stall the switcher
    guard let arr = axAttr(app, "AXWindows") as? [AXUIElement] else { return nil }
    var out: [UInt32: AXInfo] = [:]
    for el in arr {
        var wid: UInt32 = 0
        if getWin(el, &wid) != 0 || wid == 0 { continue }
        let title = (axAttr(el, "AXTitle") as? String) ?? ""
        let minimized = (axAttr(el, "AXMinimized") as? Bool) ?? false
        let subrole = (axAttr(el, "AXSubrole") as? String) ?? ""
        out[wid] = AXInfo(title: title, minimized: minimized, subrole: subrole)
        axLock.lock(); axWindows[wid] = el; axLock.unlock()
    }
    return out
}

func iconPath(_ app: NSRunningApplication) -> String {
    let key = (app.bundleIdentifier ?? "pid\(app.processIdentifier)").replacingOccurrences(of: "/", with: "_")
    let f = cacheDir + "/icon-" + key + ".png"
    if iconsWritten.contains(key) { return f }
    if FileManager.default.fileExists(atPath: f) { iconsWritten.insert(key); return f }
    if let icon = app.icon {
        var r = NSRect(x: 0, y: 0, width: 128, height: 128)
        if let cg = icon.cgImage(forProposedRect: &r, context: nil, hints: nil),
           let png = NSBitmapImageRep(cgImage: scaled(cg, 128, 128)).representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: f), options: .atomic)
            iconsWritten.insert(key)
            return f
        }
    }
    return ""
}

// every window of every regular app, front to back (CGWindowList's order is the z-order, so the most recently used
// windows of the current Space come first)
func listWindows(icons: Bool) -> [[String: Any]] {
    let me = getpid()
    guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var apps: [Int32: NSRunningApplication] = [:]
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
        apps[a.processIdentifier] = a
    }
    var axByPid: [Int32: [UInt32: AXInfo]?] = [:]
    var out: [[String: Any]] = []
    var z = 0
    for w in info {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              pid != me, pid != parentPid, let app = apps[pid],
              let wid = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
        let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        if alpha <= 0.01 { continue }
        var rect = CGRect.zero
        if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary) { rect = r }
        if rect.width < 60 || rect.height < 40 { continue }
        let onscreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
        let cgName = (w[kCGWindowName as String] as? String) ?? ""
        if axByPid[pid] == nil { axByPid[pid] = .some(axWindowsOf(pid)) }
        let ax: [UInt32: AXInfo]? = axByPid[pid] ?? nil
        var title = cgName
        var minimized = false
        var hasAX = false
        if let axw = ax {
            if let i = axw[wid] {
                hasAX = true
                if !i.title.isEmpty { title = i.title }
                minimized = i.minimized
                if i.subrole != "" && i.subrole != "AXStandardWindow" && i.subrole != "AXDialog" { continue }
            } else if onscreen || cgName.isEmpty || rect.width < 100 || rect.height < 100 {
                continue      // not a real window (helper surfaces, tool tips, invisible windows)
            }
        } else if !onscreen && cgName.isEmpty {
            continue          // without AX, keep only windows we can name or see
        }
        var d: [String: Any] = [
            "wid": wid, "pid": pid, "app": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "",
            "title": title, "x": Double(rect.origin.x), "y": Double(rect.origin.y), "w": Double(rect.width), "h": Double(rect.height),
            "onscreen": onscreen, "min": minimized, "hidden": app.isHidden, "z": z, "ax": hasAX,
        ]
        if icons { d["icon"] = iconPath(app) }
        out.append(d)
        z += 1
    }
    return out
}

func axWindow(_ wid: UInt32, _ pid: Int32) -> AXUIElement? {
    axLock.lock(); let el = axWindows[wid]; axLock.unlock()
    if let el = el { return el }
    _ = axWindowsOf(pid)
    axLock.lock(); defer { axLock.unlock() }
    return axWindows[wid]
}

// MARK: - focus, close, quit

func focus(_ wid: UInt32, _ pid: Int32) {
    let app = NSRunningApplication(processIdentifier: pid)
    if let a = app, a.isHidden { a.unhide() }
    let el = axWindow(wid, pid)
    if let el = el, (axAttr(el, "AXMinimized") as? Bool) == true {
        AXUIElementSetAttributeValue(el, "AXMinimized" as CFString, kCFBooleanFalse)
    }
    var frontOK = false
    if let gp = getPSN, let sf = setFrontProcess {
        // the exact window, not just the app: make it the front process' key window (what macOS does on a click)
        var psn = [UInt32](repeating: 0, count: 2)
        let got = psn.withUnsafeMutableBytes { gp(pid, $0.baseAddress!) }
        if got == 0 {
            frontOK = psn.withUnsafeMutableBytes { sf($0.baseAddress!, wid, 0x200) } == 0
            if let post = postEventRecord {
                var bytes = [UInt8](repeating: 0, count: 0xf8)
                bytes[0x04] = 0xf8
                bytes[0x3a] = 0x10
                var w = wid
                withUnsafeBytes(of: &w) { for i in 0..<4 { bytes[0x3c + i] = $0[i] } }
                for i in 0..<0x10 { bytes[0x20 + i] = 0xff }
                bytes[0x08] = 0x01
                _ = psn.withUnsafeMutableBytes { p in bytes.withUnsafeMutableBufferPointer { post(p.baseAddress!, $0.baseAddress!) } }
                bytes[0x08] = 0x02
                _ = psn.withUnsafeMutableBytes { p in bytes.withUnsafeMutableBufferPointer { post(p.baseAddress!, $0.baseAddress!) } }
            }
        }
    }
    if let el = el {
        AXUIElementPerformAction(el, "AXRaise" as CFString)
        AXUIElementSetAttributeValue(el, "AXMain" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXFocusedWindow" as CFString, el)
    }
    if !frontOK, let a = app {
        DispatchQueue.main.async { _ = a.activate(options: [.activateIgnoringOtherApps]) }
    }
}
func closeWindow(_ wid: UInt32, _ pid: Int32) {
    guard let el = axWindow(wid, pid), let btn = axAttr(el, "AXCloseButton") else { return }
    AXUIElementPerformAction(btn as! AXUIElement, "AXPress" as CFString)
}
func quitApp(_ pid: Int32) {
    guard let a = NSRunningApplication(processIdentifier: pid) else { return }
    DispatchQueue.main.async { _ = a.terminate() }
}

// MARK: - thumbnails

var thumbN = 0
var lastThumb: [UInt32: String] = [:]   // thumbQ only

func scaled(_ img: CGImage, _ maxW: Int, _ maxH: Int) -> CGImage {
    let s = min(Double(maxW) / Double(img.width), Double(maxH) / Double(img.height), 1)
    if s >= 0.999 { return img }
    let w = max(1, Int(Double(img.width) * s)), h = max(1, Int(Double(img.height) * s))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return img }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? img
}
func writeThumb(_ wid: UInt32, _ img: CGImage, _ maxW: Int, _ maxH: Int) {
    thumbQ.async {
        let im = scaled(img, maxW, maxH)
        let rep = NSBitmapImageRep(cgImage: im)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return }
        thumbN += 1
        let f = cacheDir + "/w\(wid)-\(thumbN).jpg"
        do { try data.write(to: URL(fileURLWithPath: f), options: .atomic) } catch { return }
        if let old = lastThumb[wid] { unlink(old) }
        lastThumb[wid] = f
        emit(["ev": "thumb", "wid": wid, "file": f, "w": im.width, "h": im.height])
    }
}
func cgThumb(_ wid: UInt32, _ maxW: Int, _ maxH: Int) -> Bool {
    guard let f = cgWindowImage, let img = f(CGRect.null, 1 << 3, wid, (1 << 0) | (1 << 4))?.takeRetainedValue() else { return false }
    if img.width < 2 || img.height < 2 { return false }
    writeThumb(wid, img, maxW, maxH)
    return true
}
func captureThumbs(_ ids: [UInt32], _ maxW: Int, _ maxH: Int) {
    guard CGPreflightScreenCaptureAccess() else { emit(["ev": "thumbfail", "wids": ids, "why": "screen"]); return }
    if #available(macOS 14.0, *) {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, _ in
            var byId: [UInt32: SCWindow] = [:]
            for w in content?.windows ?? [] { byId[w.windowID] = w }
            var failed: [UInt32] = []
            for id in ids {
                guard let w = byId[id], w.frame.width > 1, w.frame.height > 1 else {
                    if !cgThumb(id, maxW, maxH) { failed.append(id) }
                    continue
                }
                let cfg = SCStreamConfiguration()
                let s = min(Double(maxW) / Double(w.frame.width), Double(maxH) / Double(w.frame.height), 1)
                cfg.width = max(2, Int(Double(w.frame.width) * s))
                cfg.height = max(2, Int(Double(w.frame.height) * s))
                cfg.showsCursor = false
                cfg.ignoreShadowsSingleWindow = true
                let filter = SCContentFilter(desktopIndependentWindow: w)
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in
                    if let img = img { writeThumb(id, img, maxW, maxH) } else if !cgThumb(id, maxW, maxH) { emit(["ev": "thumbfail", "wids": [id]]) }
                }
            }
            if !failed.isEmpty { emit(["ev": "thumbfail", "wids": failed]) }
        }
    } else {
        var failed: [UInt32] = []
        for id in ids where !cgThumb(id, maxW, maxH) { failed.append(id) }
        if !failed.isEmpty { emit(["ev": "thumbfail", "wids": failed]) }
    }
}

// MARK: - commands from Koi

func u32(_ v: Any?) -> UInt32 { return (v as? NSNumber)?.uint32Value ?? 0 }
func i32(_ v: Any?) -> Int32 { return (v as? NSNumber)?.int32Value ?? 0 }
func perms() -> [String: Any] { return ["ax": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()] }

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let m = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
          let cmd = m["cmd"] as? String else { return }
    let id = m["id"]
    switch cmd {
    case "config":
        DispatchQueue.main.async {
            if let e = m["enabled"] as? Bool { enabled = e }
            if let r = m["replace"] as? Bool { replace = r; trigger = r ? .maskCommand : .maskAlternate }
            if !enabled { active = false }
            applyNative()
        }
    case "ack":
        DispatchQueue.main.async {
            if let s = m["seq"] as? Int, s == seq { ackItem?.cancel(); ackItem = nil }
            if bypass { bypass = false; applyNative(); emit(["ev": "tap", "state": tapState]) }
        }
    case "active":
        DispatchQueue.main.async { active = (m["on"] as? Bool) ?? false }
    case "list":
        listQ.async { emit(["re": id ?? 0, "windows": listWindows(icons: true)]) }
    case "thumbs":
        let ids = (m["ids"] as? [Any] ?? []).map { u32($0) }.filter { $0 != 0 }
        let w = (m["w"] as? Int) ?? 480, h = (m["h"] as? Int) ?? 300
        thumbQ.async { captureThumbs(ids, w, h) }
    case "focus":
        let wid = u32(m["wid"]), pid = i32(m["pid"])
        axQ.async { focus(wid, pid) }
    case "close":
        let wid = u32(m["wid"]), pid = i32(m["pid"])
        axQ.async { closeWindow(wid, pid) }
    case "quit":
        quitApp(i32(m["pid"]))
    case "perm":
        var r = perms(); r["re"] = id ?? 0; emit(r)
    case "askScreen":
        DispatchQueue.main.async { _ = CGRequestScreenCaptureAccess(); var r = perms(); r["ev"] = "perm"; emit(r) }
    case "bye":
        DispatchQueue.main.async { shutdown(0) }
    default:
        break
    }
}

func shutdown(_ code: Int32) {
    restoreNativeNow()
    outQ.sync {}
    exit(code)
}

// MARK: - main

signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

if args.contains("--restore") {
    restoreNativeNow()
    writeLine(["ok": true, "restored": setSymbolicHotKey != nil])
    exit(0)
}
if args.contains("--perm") {
    writeLine(perms())
    exit(0)
}
if args.contains("--selftest") {
    // lists windows with no permission at all (titles may be empty), never prompts, never touches Cmd+Tab
    let watchdog = DispatchWorkItem { writeLine(["ok": false, "selftest": true, "error": "timeout"]); exit(3) }
    DispatchQueue.global().asyncAfter(deadline: .now() + 20, execute: watchdog)
    let t0 = Date()
    let wins = listWindows(icons: false)
    var sc = false
    if #available(macOS 14.0, *) { sc = true }
    let sample = wins.prefix(5).map { w -> [String: Any] in ["wid": w["wid"] ?? 0, "app": w["app"] ?? "", "onscreen": w["onscreen"] ?? false] }
    writeLine(["ok": true, "selftest": true, "protocol": PROTOCOL,
               "macos": ProcessInfo.processInfo.operatingSystemVersionString,
               "ax": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess(),
               "symbolicHotKeys": setSymbolicHotKey != nil, "axGetWindow": axGetWindow != nil,
               "focusExact": getPSN != nil && setFrontProcess != nil, "screenCaptureKit": sc, "cgWindowImage": cgWindowImage != nil,
               "windows": wins.count, "sample": Array(sample), "ms": Int(Date().timeIntervalSince(t0) * 1000)])
    exit(0)
}

if let c = arg("--cache") { cacheDir = c }
if let p = arg("--parent"), let n = Int32(p) { parentPid = n }
try? FileManager.default.createDirectory(atPath: cacheDir, withIntermediateDirectories: true)
if let old = try? FileManager.default.contentsOfDirectory(atPath: cacheDir) {
    for f in old where f.hasPrefix("w") && f.hasSuffix(".jpg") { unlink(cacheDir + "/" + f) }
}
// Cmd+Tab comes back however this process ends
atexit { restoreNativeNow() }
for s in [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP] {
    signal(s) { sig in
        restoreNativeNow()
        signal(sig, SIG_DFL)
        raise(sig)
    }
}
// no App Nap and no timer coalescing for the tap (this costs nothing while no key is pressed)
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "Koi window switcher")
_ = activity

// stdin: one command per line; EOF means Koi is gone, so give Cmd+Tab back and leave
let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if !line.isEmpty { handle(line) }
    }
    DispatchQueue.main.async { shutdown(0) }
}
reader.start()

DispatchQueue.main.async {
    startTap()
    var sc = false
    if #available(macOS 14.0, *) { sc = true }
    var r = perms()
    r["ev"] = "ready"; r["protocol"] = PROTOCOL; r["tap"] = tapState
    r["symbolicHotKeys"] = setSymbolicHotKey != nil; r["focusExact"] = getPSN != nil && setFrontProcess != nil; r["screenCaptureKit"] = sc
    emit(r)
}
CFRunLoopRun()
