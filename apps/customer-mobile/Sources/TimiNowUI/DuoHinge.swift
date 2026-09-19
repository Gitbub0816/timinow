import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// Where the crease is, if there is one right now.
///
/// A folding device has a physical seam, and text laid across it is split by
/// a ridge you can feel with a fingernail. iOS 27.1 reports it as a *reserved
/// region* of kind `.division`, measured in the asking view's own coordinate
/// space — and it is **active only while the device is partially folded**. Flat
/// open, there is nothing to avoid and this is empty; that is not a failure to
/// detect the hinge, it is the hinge not mattering.
///
/// This is the one place the fold-specific API earns its keep. Layout still
/// comes from size classes (see `CustomerRootView.foldLayout`) because Apple
/// says so and because a hinge angle has nothing to say about Split View. But
/// *where the crease physically is* cannot be derived from a size class, and
/// guessing at a midpoint would be wrong on any device whose panels are not
/// equal.
public struct DuoHingeGap: Equatable, Sendable {
    /// The reserved rectangle, in the coordinate space of the view that asked.
    public var rect: CGRect?

    public static let none = DuoHingeGap(rect: nil)

    public init(rect: CGRect?) { self.rect = rect }

    public var isActive: Bool { rect != nil }

    /// True when the crease runs top-to-bottom, splitting the screen into a
    /// left panel and a right panel. A landscape-hinged device creases the
    /// other way, and the clearance then belongs on a different edge.
    public var isVertical: Bool {
        guard let rect else { return false }
        return rect.height >= rect.width
    }

    /// How far in from the trailing edge the crease's near side sits — the
    /// clearance content on the far side must leave so nothing lands in it.
    public func trailingClearance(in size: CGSize) -> CGFloat {
        guard let rect, isVertical else { return 0 }
        return max(0, size.width - rect.minX)
    }

    /// The same measured from the leading edge, for a left-handed layout.
    public func leadingClearance(in size: CGSize) -> CGFloat {
        guard let rect, isVertical else { return 0 }
        return max(0, rect.maxX)
    }
}

public enum DuoHinge {
    /// Read the active division region out of a geometry proxy.
    ///
    /// Availability-gated rather than compiled out: the app deploys to iOS 17
    /// and this is a 27.1 API, so on anything older — and on a device with no
    /// hinge at all — it simply reports nothing and every caller carries on
    /// with its ordinary spacing.
    public static func gap(_ proxy: GeometryProxy) -> DuoHingeGap {
        #if os(iOS) && !SKIP
        if #available(iOS 27.1, *) {
            let regions = proxy.reservedRegions(kind: .division)
            if let region = regions.first(where: { $0.isActive }) {
                return DuoHingeGap(rect: region.frame)
            }
        }
        #endif
        return .none
    }
}
