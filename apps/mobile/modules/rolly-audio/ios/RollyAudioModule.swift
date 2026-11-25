// ROLLY native audio: one full-duplex voice session for the conversation.
//
// - AVAudioSession: category .playAndRecord, mode .voiceChat (Apple's voice-processing I/O: echo cancellation, noise
//   suppression, automatic gain), options .allowBluetooth (Hands-Free Profile: car microphone + car speakers, 16 kHz
//   wideband at best) and .defaultToSpeaker (loudspeaker, not the earpiece, when no headset or car is connected).
// - AVAudioEngine with voice processing enabled on the input node (it applies to input and output together), so the
//   agent's own voice coming back through the microphone is cancelled on the device.
// - Capture: hardware format -> 16 kHz mono PCM16, 20 ms frames (640 bytes), sent to JS with the capture wall time.
// - Playback: PCM16 24 kHz chunks tagged with the agent-turn sequence number, scheduled on an AVAudioPlayerNode.
//   flush() drops everything scheduled immediately (barge-in).
// - Lifecycle: interruptions (phone call, Siri), route changes (Bluetooth connect/disconnect), engine configuration
//   changes and media-services resets are reported to JS and recovered from where iOS allows it.
// - Background: with UIBackgroundModes=audio and an active, running engine the app keeps running with the phone locked.
import AVFoundation
import ExpoModulesCore

public class RollyAudioModule: Module {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var converter: AVAudioConverter?
  private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  private var pending = Data() // captured 16 kHz PCM16 not yet sent (less than one frame)
  private var pendingStartMs: Double = 0
  private var running = false
  private var wantRunning = false
  private var observers: [NSObjectProtocol] = []
  private let queue = DispatchQueue(label: "rolly.audio")

  // playback bookkeeping
  private var scheduled = 0 // buffers scheduled and not yet played
  private var playingSeq: Int = -1
  private var firstReported = Set<Int>()
  private var flushedSeqs = Set<Int>()
  private var generation = 0 // bumps on flush so completions of dropped buffers are ignored

  public func definition() -> ModuleDefinition {
    Name("RollyAudio")
    Events("onMicFrame", "onPlayback", "onAudioSession")

    AsyncFunction("start") { (promise: Promise) in
      self.queue.async {
        do {
          try self.startInternal()
          promise.resolve(self.routeInfo())
        } catch {
          promise.reject("E_AUDIO_START", "Audio could not start: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.queue.async {
        self.wantRunning = false
        self.stopInternal(deactivate: true)
        promise.resolve(nil)
      }
    }

    // pcm16 base64, 24 kHz mono, tagged with the agent-turn sequence number
    Function("enqueue") { (seq: Int, base64: String) in
      guard let data = Data(base64Encoded: base64) else { return }
      self.queue.async { self.schedule(seq: seq, pcm16: data) }
    }

    // stop playback now; returns ms spent
    Function("flush") { (seq: Int) -> Double in
      let t0 = CACurrentMediaTime()
      self.queue.sync {
        self.generation += 1
        self.flushedSeqs.insert(seq)
        self.player.stop()
        self.scheduled = 0
        if self.running { self.player.play() }
      }
      let ms = (CACurrentMediaTime() - t0) * 1000
      self.sendEvent("onPlayback", ["event": "flushed", "seq": seq, "flush_ms": ms, "t": Date().timeIntervalSince1970 * 1000])
      return ms
    }

    Function("currentRoute") { () -> [String: Any] in
      return self.routeInfo()
    }

    OnDestroy {
      self.wantRunning = false
      self.stopInternal(deactivate: true)
    }
  }

  // MARK: - session and engine

  private func configureSession() throws {
    let s = AVAudioSession.sharedInstance()
    try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
    try? s.setPreferredSampleRate(16000) // HFP is 16 kHz at best; the built-in mic may stay at 48 kHz
    try? s.setPreferredIOBufferDuration(0.02)
    try s.setActive(true, options: [])
  }

  private func startInternal() throws {
    wantRunning = true
    if running { return }
    try configureSession()
    installObserversOnce()
    try buildEngine()
    running = true
    sendEvent("onAudioSession", ["event": "started", "route": routeDescription(), "t": Date().timeIntervalSince1970 * 1000])
  }

  private func buildEngine() throws {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    // voice processing must be enabled before the engine starts; it covers input and output
    if !engine.inputNode.isVoiceProcessingEnabled {
      try engine.inputNode.setVoiceProcessingEnabled(true)
    }
    if engine.attachedNodes.contains(player) == false {
      engine.attach(player)
    }
    engine.disconnectNodeOutput(player)
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)

    let inFormat = engine.inputNode.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0 else { throw NSError(domain: "RollyAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no microphone input"]) }
    converter = AVAudioConverter(from: inFormat, to: micFormat)
    pending = Data()
    engine.inputNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(inFormat.sampleRate * 0.02), format: inFormat) { [weak self] buf, when in
      self?.onInput(buf, when: when)
    }
    engine.prepare()
    try engine.start()
    player.play()
  }

  private func stopInternal(deactivate: Bool) {
    if running {
      engine.inputNode.removeTap(onBus: 0)
      player.stop()
      engine.stop()
      running = false
    }
    scheduled = 0
    if deactivate {
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
  }

  private func restart(reason: String) {
    queue.async {
      guard self.wantRunning else { return }
      self.stopInternal(deactivate: false)
      do {
        try self.configureSession()
        try self.buildEngine()
        self.running = true
        self.sendEvent("onAudioSession", ["event": "restarted", "reason": reason, "route": self.routeDescription(), "t": Date().timeIntervalSince1970 * 1000])
      } catch {
        self.sendEvent("onAudioSession", ["event": "restart_failed", "reason": "\(reason): \(error.localizedDescription)", "t": Date().timeIntervalSince1970 * 1000])
      }
    }
  }

  // MARK: - capture

  private func onInput(_ buf: AVAudioPCMBuffer, when: AVAudioTime) {
    guard let conv = converter else { return }
    let ratio = micFormat.sampleRate / buf.format.sampleRate
    let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio + 32)
    guard let out = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: cap) else { return }
    var fed = false
    var err: NSError?
    conv.convert(to: out, error: &err) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return buf
    }
    if err != nil || out.frameLength == 0 { return }
    let bytes = Int(out.frameLength) * 2
    let chunk = Data(bytes: out.int16ChannelData![0], count: bytes)
    // wall-clock time of the first sample of this buffer (for latency measured on the phone)
    let nowMs = Date().timeIntervalSince1970 * 1000
    let bufMs = Double(buf.frameLength) / buf.format.sampleRate * 1000
    if pending.isEmpty { pendingStartMs = nowMs - bufMs }
    pending.append(chunk)
    let frame = 640
    while pending.count >= frame {
      let f = pending.prefix(frame)
      pending.removeFirst(frame)
      sendEvent("onMicFrame", ["data": f.base64EncodedString(), "t": pendingStartMs])
      pendingStartMs += 20
    }
  }

  // MARK: - playback

  private func schedule(seq: Int, pcm16: Data) {
    guard running, !flushedSeqs.contains(seq) else { return }
    let n = pcm16.count / 2
    guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)) else { return }
    buf.frameLength = AVAudioFrameCount(n)
    let dst = buf.floatChannelData![0]
    pcm16.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let src = raw.bindMemory(to: Int16.self)
      for i in 0..<n { dst[i] = Float(Int16(littleEndian: src[i])) / 32768.0 }
    }
    let gen = generation
    let wasIdle = scheduled == 0
    scheduled += 1
    if !firstReported.contains(seq) {
      firstReported.insert(seq)
      let s = AVAudioSession.sharedInstance()
      // audible after what is already queued plus the output path latency (Bluetooth adds its own here)
      let audibleInMs = (s.outputLatency + s.ioBufferDuration) * 1000
      sendEvent("onPlayback", ["event": "first_audio", "seq": seq, "t": Date().timeIntervalSince1970 * 1000 + audibleInMs,
                               "output_latency_ms": s.outputLatency * 1000, "queued_before": !wasIdle])
    }
    playingSeq = seq
    player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self = self else { return }
      self.queue.async {
        guard gen == self.generation else { return }
        self.scheduled -= 1
        if self.scheduled <= 0 {
          self.scheduled = 0
          self.sendEvent("onPlayback", ["event": "idle", "seq": seq, "t": Date().timeIntervalSince1970 * 1000])
        }
      }
    }
    if !player.isPlaying { player.play() }
  }

  // MARK: - notifications

  private func installObserversOnce() {
    if !observers.isEmpty { return }
    let nc = NotificationCenter.default
    let s = AVAudioSession.sharedInstance()
    observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: s, queue: nil) { [weak self] n in
      guard let self = self, let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      if type == .began {
        self.queue.async { self.running = false; self.scheduled = 0 }
        self.sendEvent("onAudioSession", ["event": "interruption_began", "t": Date().timeIntervalSince1970 * 1000])
      } else {
        let opts = AVAudioSession.InterruptionOptions(rawValue: (n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
        self.sendEvent("onAudioSession", ["event": "interruption_ended", "should_resume": opts.contains(.shouldResume), "t": Date().timeIntervalSince1970 * 1000])
        // resume even without .shouldResume: the user started a conversation and expects it to continue after a call
        self.restart(reason: "interruption_ended")
      }
    })
    observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: s, queue: nil) { [weak self] n in
      guard let self = self else { return }
      let raw = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
      let name: String
      switch reason {
      case .newDeviceAvailable: name = "new_device_available"
      case .oldDeviceUnavailable: name = "old_device_unavailable"
      case .categoryChange: name = "category_change"
      case .override: name = "override"
      case .wakeFromSleep: name = "wake_from_sleep"
      case .noSuitableRouteForCategory: name = "no_suitable_route"
      case .routeConfigurationChange: name = "route_configuration_change"
      default: name = "other"
      }
      self.sendEvent("onAudioSession", ["event": "route_changed", "reason": name, "route": self.routeDescription(), "t": Date().timeIntervalSince1970 * 1000])
    })
    // the engine stops itself when the hardware format changes (e.g. Bluetooth HFP on/off): rebuild it
    observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      self?.restart(reason: "engine_configuration_change")
    })
    observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: s, queue: nil) { [weak self] _ in
      self?.sendEvent("onAudioSession", ["event": "media_services_reset", "t": Date().timeIntervalSince1970 * 1000])
      self?.restart(reason: "media_services_reset")
    })
  }

  private func routeDescription() -> String {
    let r = AVAudioSession.sharedInstance().currentRoute
    let ins = r.inputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
    let outs = r.outputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
    return "in=[\(ins)] out=[\(outs)]"
  }

  private func routeInfo() -> [String: Any] {
    let s = AVAudioSession.sharedInstance()
    return ["route": routeDescription(), "sample_rate": s.sampleRate, "input_latency_ms": s.inputLatency * 1000,
            "output_latency_ms": s.outputLatency * 1000, "io_buffer_ms": s.ioBufferDuration * 1000,
            "bluetooth_hfp": s.currentRoute.inputs.contains { $0.portType == .bluetoothHFP }]
  }
}
