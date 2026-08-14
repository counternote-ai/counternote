// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "audio-capture",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "AudioCaptureCore",
            targets: ["AudioCaptureCore"]
        ),
        .executable(
            name: "InterviewAudioCapture",
            targets: ["InterviewAudioCapture"]
        )
    ],
    targets: [
        .target(
            name: "AudioCaptureCore",
            path: "Sources/AudioCaptureCore"
        ),
        .executableTarget(
            name: "InterviewAudioCapture",
            dependencies: ["AudioCaptureCore"],
            path: "Sources/InterviewAudioCapture"
        ),
        .testTarget(
            name: "AudioCaptureCoreTests",
            dependencies: ["AudioCaptureCore"],
            path: "Tests/AudioCaptureCoreTests",
            resources: [
                .copy("../Fixtures")
            ]
        )
    ]
)
