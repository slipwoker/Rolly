Pod::Spec.new do |s|
  s.name           = 'RollyAudio'
  s.version        = '0.1.0'
  s.summary        = 'ROLLY full-duplex voice audio (AVAudioSession voiceChat, Bluetooth HFP, echo cancellation)'
  s.license        = 'UNLICENSED'
  s.author         = 'ROLLY'
  s.homepage       = 'https://github.com/slipwoker/Rolly'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
end
