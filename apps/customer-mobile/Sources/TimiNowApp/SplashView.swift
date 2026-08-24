import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Evander, the care companion, covering the seconds between launch and the
// session-restore verdict. Before this screen existed the app opened straight
// onto the sign-in wall and then visibly skipped past it once restore resumed
// the session — a flash of "sign in" shown to somebody who already had.
//
// This lives in TimiNowApp on purpose: the Android build does not consume this
// module, so UIKit and CoreGraphics can be used directly. It is still wrapped
// in `#if !SKIP` because the target carries the skipstone plugin, and CGImage
// has no Kotlin counterpart for the transpiler to map.
#if !SKIP

/// The sprite sheet in the app target's asset catalog
/// (Darwin/Assets.xcassets/EvanderSheet.imageset): 2048×1536, 8 columns by
/// 6 rows of 256px tiles, 48 frames at 10fps, seamless loop, transparent
/// background — the numbers recorded in evander-atlas.json.
enum EvanderSprite {
    static let columns = 8
    static let rows = 6
    static let framesPerSecond = 10.0

    /// Every tile, cropped out of the sheet exactly once at launch.
    ///
    /// Cropping per displayed frame would allocate a CGImage ten times a
    /// second for the whole splash; cropping up front is 48 small copies made
    /// once. Returns all 48 or none: a partial set would loop with a visible
    /// skip, and the caller treats empty as "show no splash at all" rather
    /// than animating an empty square.
    static func loadFrames() -> [CGImage] {
        #if canImport(UIKit)
        guard let sheet = UIImage(named: "EvanderSheet")?.cgImage else { return [] }
        // Tile geometry from the sheet itself rather than a hardcoded 256, so
        // a re-exported sheet at another pixel density still crops inside its
        // own bounds instead of returning nil tiles past the right edge.
        let tileWidth = sheet.width / columns
        let tileHeight = sheet.height / rows
        guard tileWidth > 0, tileHeight > 0 else { return [] }
        var frames: [CGImage] = []
        for row in 0..<rows {
            for column in 0..<columns {
                let rect = CGRect(x: column * tileWidth, y: row * tileHeight, width: tileWidth, height: tileHeight)
                if let tile = sheet.cropping(to: rect) { frames.append(tile) }
            }
        }
        return frames.count == columns * rows ? frames : []
        #else
        // The macOS host build compiles this module for `swift build` even
        // though the app never ships there; no UIKit means no sheet and no
        // splash, which is the honest answer on that platform.
        return []
        #endif
    }
}

/// The launch screen: Evander looping on the app's warm canvas.
///
/// The colors are restated literally here because the app's palette lives in
/// the UI module and is internal to it — these are the same canvas and ink
/// values its theme file declares.
struct SplashView: View {
    /// Pre-cropped by EvanderSprite.loadFrames(); never empty, because the
    /// root view skips the splash entirely when loading failed.
    let frames: [CGImage]
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        ZStack {
            Color(red: 0.965, green: 0.969, blue: 0.984).ignoresSafeArea()
            VStack(spacing: 20) {
                evander
                Text("Tími")
                    .font(.system(size: 36, weight: .bold, design: .serif))
                    .foregroundStyle(Color(red: 0.067, green: 0.106, blue: 0.231))
            }
        }
    }

    @ViewBuilder private var evander: some View {
        if reduceMotion {
            // Reduce Motion means exactly that: the first frame, held still.
            frameView(0)
        } else {
            // Driven by the wall clock rather than an accumulated counter, so
            // a dropped tick cannot slow the loop — and the 48-frame cycle
            // divides evenly, so the modulo never lands on a seam.
            TimelineView(.periodic(from: .now, by: 1.0 / EvanderSprite.framesPerSecond)) { context in
                let tick = Int(context.date.timeIntervalSinceReferenceDate * EvanderSprite.framesPerSecond)
                frameView(tick % frames.count)
            }
        }
    }

    private func frameView(_ index: Int) -> some View {
        Image(decorative: frames[min(max(index, 0), frames.count - 1)], scale: 1)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: 180, height: 180)
            .accessibilityHidden(true)
    }
}

#endif
