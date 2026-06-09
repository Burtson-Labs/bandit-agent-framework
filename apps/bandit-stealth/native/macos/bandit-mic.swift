// bandit-mic — minimal macOS microphone recorder for the Bandit Stealth
// VS Code extension.
//
// Why this exists at all:
// VS Code webviews live inside a sandboxed Chromium iframe with a stable
// `vscode-webview://<id>` origin. Chromium caches per-origin permission
// verdicts in the editor's `Preferences` file, and once a "denied" verdict
// lands there it survives reloads, TCC resets, and the OS-level "allow"
// click. The only reliable recoveries are deleting the Preferences file
// by hand or reinstalling — neither of which we want to ship as guidance.
//
// The fix is to never use the webview's getUserMedia at all. The extension
// host runs in VS Code's main Node process and inherits VS Code's TCC mic
// permission once the user grants it. Spawning *this* binary as a child of
// the extension means the child inherits that permission; macOS attributes
// the mic request to "Visual Studio Code", not to bandit-mic.
//
// Wire format: 16 kHz mono 16-bit PCM WAV at the path passed as argv[1].
// Same shape the gateway transcribe endpoint accepts everywhere else, so
// nothing downstream changes.
//
// Lifecycle:
//   - Recording starts immediately on launch.
//   - SIGINT or SIGTERM finalizes the WAV header and exits 0.
//   - SIGKILL would truncate the file (no header finalization), so the
//     extension always sends SIGTERM first and falls back to SIGKILL only
//     after a grace period — same pattern as our ffmpeg fallback path.
//
// Build (universal arm64+x86_64, ad-hoc signed so VS Code can spawn it):
//   swiftc -O -emit-executable -target arm64-apple-macos11   -o bandit-mic-arm64 bandit-mic.swift
//   swiftc -O -emit-executable -target x86_64-apple-macos11  -o bandit-mic-x64   bandit-mic.swift
//   lipo -create bandit-mic-arm64 bandit-mic-x64 -output bandit-mic-darwin
//   codesign --sign - bandit-mic-darwin
//
// Code signing note: ad-hoc `codesign --sign -` is sufficient when the
// binary is invoked by an already-signed parent (VS Code itself). We are
// NOT distributing this for the user to double-click, so notarization is
// not required. If we ever want users to launch it directly, we'd need a
// Developer ID certificate.
//
// Exit codes:
//   0 — clean stop, WAV present and >64 bytes
//   2 — usage error (missing argv)
//   3 — AVAudioRecorder.record() returned false
//   4 — AVAudioRecorder init threw
//   5 — clean stop but file is missing (silent TCC denial mid-record)
//   6 — clean stop but file is header-only (~64 bytes, no audio captured)
//   7 — TCC microphone permission denied at startup (fail fast, no record())

import Foundation
import AVFoundation

// All stderr writes go through this so we can prefix consistently and
// the parent extension can grep for `bandit-mic:` lines if it wants to
// distinguish our diagnostics from any framework warnings macOS may
// emit on the same stderr fd.
func log(_ message: String) {
    FileHandle.standardError.write(Data("bandit-mic: \(message)\n".utf8))
}

guard CommandLine.arguments.count >= 2 else {
    log("usage: bandit-mic <output-file.wav>")
    exit(2)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
log("starting (output=\(outputURL.path))")

// Module-scope recorder ref. Set after successful init below; nil while
// the audio session is still warming up. The signal handler reads this
// to decide between "killed during init" (recorder == nil → exit 8) and
// "stopped while recording" (recorder != nil → performStop). Made global
// so the handler closures can reach it without capturing a `let`.
var globalRecorder: AVAudioRecorder?

// Install signal handlers IMMEDIATELY, before any slow setup. Previously
// these were set after AVAudioRecorder init — but the constructor takes
// 50-300ms on a cold audio session, and if the user releases the mic
// button (or the extension auto-stops) inside that window, SIGTERM
// arrives BEFORE our handlers are wired. The kernel default action then
// terminates the process mid-init. The parent extension sees a clean
// exit + missing WAV and reports "no audio file" — but the binary
// never even reached `record()`, so it had no chance to capture
// anything. Wiring SIG_IGN + DispatchSourceSignal up front means an
// early SIGTERM gets dispatched to a real handler that logs the cause
// and exits cleanly (exit 8 = killed before record).
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

func handleStopSignal(reason: String) -> Never {
    guard let recorder = globalRecorder else {
        log("received \(reason) during initialization — recorder was still setting up the audio session and never started capturing. The parent likely sent stop too quickly after start (audio session warmup is 50-300ms on cold start); consider holding the mic button longer or check that the extension isn't auto-stopping immediately.")
        exit(8)
    }
    log("stopping (reason=\(reason))")
    recorder.stop()
    let attrs = try? FileManager.default.attributesOfItem(atPath: outputURL.path)
    let size = (attrs?[.size] as? NSNumber)?.intValue ?? -1
    log("post-stop file size=\(size) bytes")
    if size <= 0 {
        log("no audio captured — file is missing or empty. AVAudioRecorder.record() returned true but the OS delivered zero samples. This is the macOS \"silent TCC denial\" mode: TCC says authorized but the audio subsystem is suppressing capture. Try: tccutil reset Microphone, then re-grant in System Settings → Privacy & Security → Microphone, then Cmd+Q the editor and reopen.")
        exit(5)
    }
    if size <= 64 {
        log("empty WAV (\(size) bytes — header only). Microphone produced no audio samples during recording. Check that an input device is selected (System Settings → Sound → Input) and that the input level meter moves when you speak.")
        exit(6)
    }
    log("clean stop, \(size) bytes captured")
    exit(0)
}

let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { handleStopSignal(reason: "SIGTERM") }
termSource.resume()

let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { handleStopSignal(reason: "SIGINT") }
intSource.resume()

// TCC permission probe BEFORE we touch AVAudioRecorder. AVAudioRecorder's
// record() returns true even when the OS will silently deliver zero
// samples, which is the failure mode we keep getting reports of: the
// recorder "starts," the user speaks, the parent sends SIGTERM, and the
// WAV file was never written because TCC quietly suppressed every read.
// Checking authorizationStatus up-front lets us surface the actual error
// instead of guessing post-hoc. Note: the request goes through the parent
// process's TCC entry (Visual Studio Code / Cursor) — bandit-mic itself
// does not appear in System Settings → Privacy & Security → Microphone.
let authStatus = AVCaptureDevice.authorizationStatus(for: .audio)
log("TCC mic auth=\(authStatus.rawValue) (\(describeAuth(authStatus)))")
switch authStatus {
case .authorized:
    break
case .denied, .restricted:
    log("microphone access denied for the parent process. Grant your editor access in System Settings → Privacy & Security → Microphone, then fully quit and reopen the editor (Cmd+Q, not just window close).")
    exit(7)
case .notDetermined:
    // First-launch path. Trigger the macOS dialog (attributed to the
    // parent process) and block until the user clicks. If they deny, we
    // bail with the same diagnostic — the extension will surface it as
    // a toast.
    log("requesting microphone access (first run; macOS dialog will appear attributed to the parent editor)")
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { allowed in
        granted = allowed
        semaphore.signal()
    }
    semaphore.wait()
    if !granted {
        log("user denied microphone access in the system dialog.")
        exit(7)
    }
    log("user granted microphone access.")
@unknown default:
    log("unknown TCC auth status (\(authStatus.rawValue)); proceeding anyway.")
}

func describeAuth(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

// Pinned to 16 kHz mono signed 16-bit little-endian PCM. The gateway
// transcription endpoint accepts WAV at any sample rate, but pinning here
// keeps file size predictable (~32 kB/sec) and matches what ffmpeg /
// arecord produce on the other platforms — one mime type for the entire
// pipeline.
let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 16000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false
]

log("constructing AVAudioRecorder…")
do {
    globalRecorder = try AVAudioRecorder(url: outputURL, settings: settings)
} catch {
    log("recorder init failed: \(error.localizedDescription)")
    exit(4)
}
log("AVAudioRecorder constructed; calling record()…")
guard let recorder = globalRecorder, recorder.record() else {
    log("AVAudioRecorder.record() returned false — usually means TCC denied between probe and record(), or the audio session couldn't be acquired.")
    exit(3)
}
log("recording started")

// Block forever — the dispatch sources installed above will fire
// handleStopSignal() on the main queue when SIGTERM/SIGINT arrives, and
// handleStopSignal is `-> Never` so the process exits from inside the
// handler. We deliberately don't add a max duration — the parent
// extension is responsible for sending the stop signal at the user's
// record-button release.
RunLoop.main.run()
