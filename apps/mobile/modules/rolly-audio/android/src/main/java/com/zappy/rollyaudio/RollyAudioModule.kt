// ROLLY native audio for Android: one full-duplex voice session for the conversation. Same JS API, events and data
// formats as ios/RollyAudioModule.swift (see src/index.ts).
//
// - AudioManager in MODE_IN_COMMUNICATION and audio focus for voice communication (phone calls and other apps
//   interrupt us; we resume when focus comes back).
// - Capture: AudioRecord, source VOICE_COMMUNICATION (the platform's voice processing: echo cancellation, noise
//   suppression, gain control; the AEC/NS effects are also attached explicitly where the device offers them),
//   16 kHz mono PCM16, 20 ms frames (640 bytes) sent to JS with the capture wall time.
// - Playback: AudioTrack, usage VOICE_COMMUNICATION, 24 kHz mono PCM16, fed by a writer thread from a queue of chunks
//   tagged with the agent-turn sequence number. flush() drops everything queued and buffered immediately (barge-in).
// - Routing: car / headset Bluetooth (SCO or BLE audio) first, then wired or USB headset, else the loudspeaker (not the
//   earpiece). Re-chosen when devices come and go; reported to JS as route changes.
// - Background: a microphone foreground service (RollyAudioService) runs while a conversation is active, so capture
//   continues with the screen locked.
package com.zappy.rollyaudio

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class RollyAudioModule : Module() {
  private val micRate = 16000
  private val playRate = 24000
  private val frameBytes = 640 // 20 ms of 16 kHz mono PCM16

  private val worker = HandlerThread("rolly.audio").apply { start() }
  private val handler = Handler(worker.looper)

  @Volatile private var running = false
  @Volatile private var wantRunning = false
  private var record: AudioRecord? = null
  private var track: AudioTrack? = null
  private var captureThread: Thread? = null
  private var playThread: Thread? = null
  private var effects = mutableListOf<android.media.audiofx.AudioEffect>()
  private var focusRequest: AudioFocusRequest? = null
  private var deviceCallback: AudioDeviceCallback? = null
  private var serviceStarted = false

  // playback bookkeeping (writer thread + flush from the JS thread)
  private class Chunk(val seq: Int, val gen: Int, val pcm: ByteArray)
  private val queue = LinkedBlockingQueue<Chunk>()
  @Volatile private var generation = 0
  private val flushedSeqs = java.util.Collections.synchronizedSet(mutableSetOf<Int>())
  private val firstReported = java.util.Collections.synchronizedSet(mutableSetOf<Int>())
  private val lock = Object()
  private var framesWritten = 0L // frames handed to the track since the last flush, relative to headBase
  private var headBase = 0L
  private var busy = false
  private var lastSeq = -1

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no React context")
  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("RollyAudio")
    Events("onMicFrame", "onPlayback", "onAudioSession")

    AsyncFunction("start") { promise: Promise ->
      withMicPermission(
        onGranted = {
          handler.post {
            try {
              startInternal()
              promise.resolve(routeInfo())
            } catch (e: Throwable) {
              stopInternal(release = true)
              promise.reject("E_AUDIO_START", "Audio could not start: ${e.message}", e)
            }
          }
        },
        onDenied = { promise.reject("E_AUDIO_PERMISSION", "Microphone permission was not granted", null) },
      )
    }

    AsyncFunction("stop") { promise: Promise ->
      handler.post {
        wantRunning = false
        stopInternal(release = true)
        promise.resolve(null)
      }
    }

    // pcm16 base64, 24 kHz mono, tagged with the agent-turn sequence number
    Function("enqueue") { seq: Int, base64: String ->
      if (!running || flushedSeqs.contains(seq)) return@Function
      val pcm = try { Base64.decode(base64, Base64.DEFAULT) } catch (e: IllegalArgumentException) { return@Function }
      if (pcm.size >= 2) queue.offer(Chunk(seq, generation, pcm))
    }

    // stop playback now; returns ms spent
    Function("flush") { seq: Int ->
      val t0 = SystemClock.elapsedRealtimeNanos()
      flushedSeqs.add(seq)
      synchronized(lock) {
        generation += 1
        queue.clear()
        track?.let { t ->
          try {
            t.pause()
            t.flush()
            headBase = t.playbackHeadPosition.toLong() and 0xffffffffL
            framesWritten = 0
            busy = false
            if (running) t.play()
          } catch (_: IllegalStateException) {}
        }
      }
      val ms = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
      sendEvent("onPlayback", mapOf("event" to "flushed", "seq" to seq, "flush_ms" to ms, "t" to now()))
      ms
    }

    Function("currentRoute") {
      routeInfo()
    }

    OnDestroy {
      wantRunning = false
      stopInternal(release = true)
      worker.quitSafely()
    }
  }

  // ---------------------------------------------------------------- permission

  private fun withMicPermission(onGranted: () -> Unit, onDenied: () -> Unit) {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      onGranted(); return
    }
    val permissions = appContext.permissions ?: run { onDenied(); return }
    permissions.askForPermissions(PermissionsResponseListener { result ->
      if (result[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED) onGranted() else onDenied()
    }, Manifest.permission.RECORD_AUDIO)
  }

  // ---------------------------------------------------------------- lifecycle

  private fun startInternal() {
    wantRunning = true
    if (running) return
    val am = audioManager
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    requestFocus()
    selectRoute()
    registerDeviceCallbackOnce()
    startForegroundService()
    buildAudio()
    running = true
    sendEvent("onAudioSession", mapOf("event" to "started", "route" to routeDescription(), "t" to now()))
  }

  private fun buildAudio() {
    val minIn = AudioRecord.getMinBufferSize(micRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minIn <= 0) throw IllegalStateException("16 kHz mono capture is not supported on this device")
    @Suppress("MissingPermission")
    val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, micRate, AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT, maxOf(minIn, frameBytes * 4))
    if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); throw IllegalStateException("no microphone input") }
    attachEffects(rec.audioSessionId)

    val minOut = AudioTrack.getMinBufferSize(playRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val fmt = AudioFormat.Builder().setSampleRate(playRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
    val trk = AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(fmt)
      .setBufferSizeInBytes(maxOf(minOut, playRate / 10 * 2)) // ~100 ms
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setSessionId(rec.audioSessionId) // same session as the capture, so the echo canceller has the reference
      .build()
    if (trk.state != AudioTrack.STATE_INITIALIZED) { trk.release(); rec.release(); throw IllegalStateException("no audio output") }

    synchronized(lock) {
      record = rec
      track = trk
      queue.clear()
      framesWritten = 0
      headBase = 0
      busy = false
    }
    rec.startRecording()
    trk.play()
    startCaptureThread(rec)
    startPlayThread(trk)
  }

  private fun attachEffects(session: Int) {
    effects.forEach { try { it.release() } catch (_: Throwable) {} }
    effects.clear()
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(session)?.let { it.enabled = true; effects.add(it) }
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(session)?.let { it.enabled = true; effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(session)?.let { it.enabled = true; effects.add(it) }
  }

  private fun stopInternal(release: Boolean) {
    running = false
    val ct = captureThread; val pt = playThread
    captureThread = null; playThread = null
    ct?.interrupt(); pt?.interrupt()
    // stop() / pause()+flush() return a blocked read() / write(); join before releasing the native objects
    record?.let { try { it.stop() } catch (_: Throwable) {} }
    track?.let { try { it.pause(); it.flush() } catch (_: Throwable) {} }
    try { ct?.join(300); pt?.join(300) } catch (_: InterruptedException) {}
    synchronized(lock) {
      queue.clear()
      record?.let { try { it.release() } catch (_: Throwable) {} }
      track?.let { try { it.stop() } catch (_: Throwable) {}; try { it.release() } catch (_: Throwable) {} }
      record = null
      track = null
      busy = false
    }
    effects.forEach { try { it.release() } catch (_: Throwable) {} }
    effects.clear()
    if (release) {
      clearRoute()
      abandonFocus()
      unregisterDeviceCallback()
      stopForegroundService()
      try { audioManager.mode = AudioManager.MODE_NORMAL } catch (_: Throwable) {}
      firstReported.clear()
      flushedSeqs.clear()
    }
  }

  private fun restart(reason: String) {
    handler.post {
      if (!wantRunning) return@post
      stopInternal(release = false)
      try {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        selectRoute()
        buildAudio()
        running = true
        sendEvent("onAudioSession", mapOf("event" to "restarted", "reason" to reason, "route" to routeDescription(), "t" to now()))
      } catch (e: Throwable) {
        sendEvent("onAudioSession", mapOf("event" to "restart_failed", "reason" to "$reason: ${e.message}", "t" to now()))
      }
    }
  }

  // ---------------------------------------------------------------- capture

  private fun startCaptureThread(rec: AudioRecord) {
    captureThread = Thread({
      android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
      val buf = ByteArray(frameBytes)
      while (!Thread.currentThread().isInterrupted) {
        var got = 0
        while (got < frameBytes) {
          val n = try { rec.read(buf, got, frameBytes - got) } catch (_: Throwable) { -1 }
          if (n <= 0) break
          got += n
        }
        if (got < frameBytes) {
          if (Thread.currentThread().isInterrupted || !running) break
          try { Thread.sleep(10) } catch (_: InterruptedException) { break } // device error: do not spin
          continue
        }
        // read() returns once the 20 ms frame is complete: its first sample was captured ~20 ms ago
        val t = now() - 20.0
        sendEvent("onMicFrame", mapOf("data" to Base64.encodeToString(buf, Base64.NO_WRAP), "t" to t))
      }
    }, "rolly.capture").apply { start() }
  }

  // ---------------------------------------------------------------- playback

  private fun startPlayThread(trk: AudioTrack) {
    playThread = Thread({
      android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
      val piece = playRate / 50 * 2 // 20 ms of 24 kHz PCM16: write in small pieces so a flush takes effect quickly
      while (!Thread.currentThread().isInterrupted) {
        val c = try { queue.poll(20, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { break }
        if (c == null) { checkIdle(trk); continue }
        if (c.gen != generation || flushedSeqs.contains(c.seq)) continue
        reportFirstAudio(trk, c.seq)
        var off = 0
        while (off < c.pcm.size && c.gen == generation && !Thread.currentThread().isInterrupted) {
          val len = minOf(piece, c.pcm.size - off)
          val n = try { trk.write(c.pcm, off, len, AudioTrack.WRITE_BLOCKING) } catch (_: Throwable) { -1 }
          if (n <= 0) break
          synchronized(lock) {
            if (c.gen == generation) { framesWritten += n / 2; busy = true; lastSeq = c.seq }
          }
          off += n
        }
      }
    }, "rolly.playback").apply { start() }
  }

  private fun playedFrames(trk: AudioTrack): Long = ((trk.playbackHeadPosition.toLong() and 0xffffffffL) - headBase).coerceAtLeast(0)

  private fun reportFirstAudio(trk: AudioTrack, seq: Int) {
    if (!firstReported.add(seq)) return
    val ahead: Long
    synchronized(lock) { ahead = (framesWritten - playedFrames(trk)).coerceAtLeast(0) }
    val outputLatencyMs = trk.bufferSizeInFrames * 1000.0 / playRate
    sendEvent("onPlayback", mapOf("event" to "first_audio", "seq" to seq, "t" to now() + ahead * 1000.0 / playRate + outputLatencyMs,
      "output_latency_ms" to outputLatencyMs, "queued_before" to (ahead > 0)))
  }

  private fun checkIdle(trk: AudioTrack) {
    var seq = -1
    synchronized(lock) {
      if (!busy || !queue.isEmpty()) return
      if (playedFrames(trk) < framesWritten) return
      busy = false
      seq = lastSeq
    }
    sendEvent("onPlayback", mapOf("event" to "idle", "seq" to seq, "t" to now()))
  }

  // ---------------------------------------------------------------- focus (calls, other apps)

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> handler.post {
        if (!running) return@post
        stopInternal(release = false)
        sendEvent("onAudioSession", mapOf("event" to "interruption_began", "t" to now()))
      }
      AudioManager.AUDIOFOCUS_GAIN -> handler.post {
        if (!wantRunning || running) return@post
        sendEvent("onAudioSession", mapOf("event" to "interruption_ended", "should_resume" to true, "t" to now()))
        // resume like iOS does: the user started a conversation and expects it to continue after a call
        restart("interruption_ended")
      }
    }
  }

  private fun requestFocus() {
    val am = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener(focusListener, handler)
        .setAcceptsDelayedFocusGain(false)
        .build()
      focusRequest = req
      am.requestAudioFocus(req)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
    }
  }

  private fun abandonFocus() {
    val am = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focusRequest?.let { am.abandonAudioFocusRequest(it) }
    else @Suppress("DEPRECATION") am.abandonAudioFocus(focusListener)
    focusRequest = null
  }

  // ---------------------------------------------------------------- routing

  private val preferred = listOf(
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, 26 /* TYPE_BLE_HEADSET (API 31) */, AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
  )

  private fun selectRoute() {
    val am = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = am.availableCommunicationDevices
      val pick = preferred.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } }
      if (pick != null && am.communicationDevice?.id != pick.id) am.setCommunicationDevice(pick)
    } else {
      @Suppress("DEPRECATION")
      run {
        val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val sco = outs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        val wired = outs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_USB_HEADSET }
        if (sco && am.isBluetoothScoAvailableOffCall) {
          am.isSpeakerphoneOn = false
          am.startBluetoothSco()
          am.isBluetoothScoOn = true
        } else {
          if (am.isBluetoothScoOn) { am.isBluetoothScoOn = false; am.stopBluetoothSco() }
          am.isSpeakerphoneOn = !wired
        }
      }
    }
  }

  private fun clearRoute() {
    val am = audioManager
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
      else @Suppress("DEPRECATION") run {
        if (am.isBluetoothScoOn) { am.isBluetoothScoOn = false; am.stopBluetoothSco() }
        am.isSpeakerphoneOn = false
      }
    } catch (_: Throwable) {}
  }

  private fun registerDeviceCallbackOnce() {
    if (deviceCallback != null) return
    val cb = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = onDevicesChanged("new_device_available")
      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = onDevicesChanged("old_device_unavailable")
    }
    deviceCallback = cb
    audioManager.registerAudioDeviceCallback(cb, handler)
  }

  private fun unregisterDeviceCallback() {
    deviceCallback?.let { try { audioManager.unregisterAudioDeviceCallback(it) } catch (_: Throwable) {} }
    deviceCallback = null
  }

  private fun onDevicesChanged(reason: String) {
    if (!wantRunning) return
    selectRoute()
    sendEvent("onAudioSession", mapOf("event" to "route_changed", "reason" to reason, "route" to routeDescription(), "t" to now()))
  }

  private fun typeName(t: Int): String = when (t) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BluetoothHFP"
    26 -> "BluetoothLE"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BluetoothA2DP"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Headset"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Headphones"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "USBHeadset"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Receiver"
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "MicrophoneBuiltIn"
    else -> "type$t"
  }

  private fun routeDescription(): String {
    val am = audioManager
    val out: AudioDeviceInfo? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.communicationDevice else null
    val outs = out?.let { "${typeName(it.type)}:${it.productName}" } ?: run {
      @Suppress("DEPRECATION")
      when { am.isBluetoothScoOn -> "BluetoothHFP"; am.isSpeakerphoneOn -> "Speaker"; else -> "Receiver" }
    }
    val inDev = record?.routedDevice
    val ins = inDev?.let { "${typeName(it.type)}:${it.productName}" } ?: ""
    return "in=[$ins] out=[$outs]"
  }

  private fun bluetoothHfp(): Boolean {
    val am = audioManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.communicationDevice?.type.let { it == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it == 26 }
    else @Suppress("DEPRECATION") am.isBluetoothScoOn
  }

  private fun routeInfo(): Map<String, Any?> {
    val trk = track
    val outMs = trk?.let { it.bufferSizeInFrames * 1000.0 / playRate } ?: 0.0
    return mapOf("route" to routeDescription(), "sample_rate" to micRate.toDouble(), "input_latency_ms" to 20.0,
      "output_latency_ms" to outMs, "io_buffer_ms" to 20.0, "bluetooth_hfp" to bluetoothHfp())
  }

  // ---------------------------------------------------------------- foreground service

  private fun startForegroundService() {
    if (serviceStarted) return
    try {
      val intent = Intent(context, RollyAudioService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      serviceStarted = true
    } catch (e: Throwable) {
      // capture still works while the app is visible; only background listening is lost
      sendEvent("onAudioSession", mapOf("event" to "background_unavailable", "reason" to (e.message ?: "foreground service refused"), "t" to now()))
    }
  }

  private fun stopForegroundService() {
    if (!serviceStarted) return
    try { context.stopService(Intent(context, RollyAudioService::class.java)) } catch (_: Throwable) {}
    serviceStarted = false
  }

  private fun now(): Double = System.currentTimeMillis().toDouble()
}
