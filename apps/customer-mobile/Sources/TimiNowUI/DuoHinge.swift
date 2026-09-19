import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// Where the crease is, if there is one right now.
///
/// A folding device has a physical seam, and text laid across it is split by a
/// ridge you can feel with a fingernail. iOS 27.1 reports it as a *reserved
/// region* of kind `.division`, measured in the asking view's own coordinate
/// space — and it is **active only while the device is partially folded**. Flat
/// open, there is nothing to avoid and this reports zero; that is the hinge
/// not mattering rather than a failure to find it.
///
/// This is the one place the fold-specific API earns its keep. Layout still
/// comes from size classes (see `CustomerRootView.foldLayout`) because Apple
/// says so and because a hinge angle has nothing to say about Split View. But
/// *where the crease physically is* cannot be derived from a size class, and
/// guessing at a midpoint would be wrong on any device whose panels are not
/// equal.
///
/// ── Why this hands back numbers, not a rectangle ─────────────────────────
///
/// Skip transpiles this target to Kotlin, and CGRect and CGSize have no
/// counterpart there — so they cannot appear in a *declaration* in this
/// module at all, public or not. An earlier version of this file carried a
/// `DuoHingeGap` struct with a `CGRect` property and four `'CGRect' is not a
/// bridged type` errors with it. Making it internal changed nothing, because
/// the transpiler reads the whole file either way.
///
/// So the interface is two CGFloats and a Bool, which bridge cleanly, and
/// every CG type stays inside a function body that Android never compiles.
enum DuoHinge {

    /// Clearance the content on the far side must leave so nothing lands in
    /// the crease, measured from whichever edge the hand is on. Zero when the
    /// device is flat, has no hinge, or is running an OS without the API.
    static func creaseClearance(_ proxy: GeometryProxy, fromTrailing: Bool) -> CGFloat {
        #if os(iOS) && !SKIP
        if #available(iOS 27.1, *) {
            let regions = proxy.reservedRegions(kind: .division)
            guard let region = regions.first(where: { $0.isActive }) else { return 0 }
            let rect = region.frame
            // A crease running top to bottom splits the screen left and right,
            // which is the only case a horizontal clearance answers. A device
            // hinged the other way needs a different edge, and returning zero
            // is honest about not handling it yet.
            guard rect.height >= rect.width else { return 0 }
            return fromTrailing
                ? max(0, proxy.size.width - rect.minX)
                : max(0, rect.maxX)
        }
        #endif
        return 0
    }

    /// Whether a crease is currently splitting the screen into two panels.
    static func isCreased(_ proxy: GeometryProxy) -> Bool {
        creaseClearance(proxy, fromTrailing: true) > 0
    }
}
