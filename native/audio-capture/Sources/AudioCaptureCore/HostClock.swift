import Foundation

// MARK: - Host Clock Protocol

public protocol HostClock {
    /// Returns the current host time in nanoseconds
    func now() -> UInt64

    /// Converts host time to seconds
    func toSeconds(_ hostTime: UInt64) -> Double

    /// Converts seconds to host time
    func fromSeconds(_ seconds: Double) -> UInt64
}

// MARK: - System Host Clock

public class SystemHostClock: HostClock {
    public init() {}

    public func now() -> UInt64 {
        // TimelineMixer uses nanosecond durations and compares callback times
        // directly with this value, so raw Mach ticks would put the two clock
        // domains out of sync on machines whose timebase is not 1:1.
        return Self.nanoseconds(fromMachTicks: mach_absolute_time())
    }

    public func toSeconds(_ hostTime: UInt64) -> Double {
        return Double(hostTime) / 1_000_000_000
    }

    public func fromSeconds(_ seconds: Double) -> UInt64 {
        return UInt64(seconds * 1_000_000_000)
    }

    public static func nanoseconds(fromMachTicks ticks: UInt64) -> UInt64 {
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        return UInt64(
            (Double(ticks) * Double(timebase.numer) / Double(timebase.denom)).rounded()
        )
    }
}

// MARK: - Fake Host Clock (for testing)

public class FakeHostClock: HostClock {
    private var currentTime: UInt64

    public init(initialTime: UInt64 = 0) {
        self.currentTime = initialTime
    }

    public func now() -> UInt64 {
        return currentTime
    }

    public func toSeconds(_ hostTime: UInt64) -> Double {
        return Double(hostTime) / 1_000_000_000
    }

    public func fromSeconds(_ seconds: Double) -> UInt64 {
        return UInt64(seconds * 1_000_000_000)
    }

    /// Advance the clock by the specified nanoseconds
    public func advance(by nanoseconds: UInt64) {
        currentTime &+= nanoseconds
    }

    /// Set the clock to a specific time
    public func set(to time: UInt64) {
        currentTime = time
    }
}
