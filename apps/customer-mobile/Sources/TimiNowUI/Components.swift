import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif
#if !SKIP && canImport(UIKit)
import UIKit
#endif

/// Falls back to type when the bundled artwork is missing.
///
/// `Image(_:bundle:)` renders an empty view for a name it cannot resolve, so a
/// resource that fails to make it into the app is a silent hole in the layout
/// rather than an error — which is exactly how it presented: a blank top-left
/// corner on the home screen with nothing to search for. Drawing the wordmark
/// as text instead means the app always reads as Tími.
struct TimiWordmark: View {
    var compact = false

    var body: some View {
        #if !SKIP && canImport(UIKit)
        if let artwork = UIImage(named: "timinow-wordmark", in: .module, with: nil) {
            Image(uiImage: artwork)
                .resizable().scaledToFit()
                .frame(width: CGFloat(compact ? 132 : 194), height: CGFloat(compact ? 46 : 68))
                .accessibilityLabel("Tími NOW")
        } else {
            lettering
        }
        #else
        Image("timinow-wordmark", bundle: .module)
            .resizable().scaledToFit()
            .frame(width: CGFloat(compact ? 132 : 194), height: CGFloat(compact ? 46 : 68))
            .accessibilityLabel("Tími NOW")
        #endif
    }

    private var lettering: some View {
        HStack(spacing: 4) {
            Text("Tími")
                .font(.system(size: CGFloat(compact ? 27 : 40), weight: .bold, design: .serif))
                .foregroundStyle(TimiColor.ink)
            Text("NOW")
                .font(.system(size: CGFloat(compact ? 12 : 17), weight: .black))
                .tracking(1.2)
                .foregroundStyle(.white)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(TimiColor.coral, in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityElement()
        .accessibilityLabel("Tími NOW")
    }
}

/// What happens when you tap the button, in one panel.
///
/// This replaces a decorative card that showed a floating illustration beside
/// the words "Live intake near you" — which said nothing, and rendered as an
/// empty blue rectangle whenever the illustration failed to load. The numbers
/// here are the actual product promise, and they need no artwork to survive.
struct CareLaunchPanel: View {
    var petName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 11) {
                ZStack {
                    Circle().fill(TimiColor.blue).frame(width: 42, height: 42)
                    Image(systemName: "wave.3.right")
                        .font(.system(size: 17, weight: .black)).foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("One intake, many answers")
                        .font(.system(size: 17, weight: .black)).foregroundStyle(TimiColor.ink)
                    Text("Nothing is booked for \(petName) until you choose.")
                        .font(.caption).foregroundStyle(TimiColor.muted)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                step("30", "asked", TimiColor.blueSoft)
                chevron
                step("5", "answer", TimiColor.goldSoft)
                chevron
                step("1", "you pick", TimiColor.coralSoft)
            }
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .black)).foregroundStyle(TimiColor.muted)
    }

    private func step(_ value: String, _ label: String, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.system(size: 22, weight: .bold, design: .serif)).foregroundStyle(TimiColor.ink)
            Text(label).font(.system(size: 10, weight: .black)).tracking(0.6).foregroundStyle(TimiColor.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(tint, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct CareCompanionArtwork: View {
    var compact = false
    @State var floating = false

    var body: some View {
        Image("timi-care-companion", bundle: .module)
            .resizable()
            .scaledToFit()
            .frame(maxHeight: CGFloat(compact ? 182 : 310))
            .offset(y: CGFloat(floating ? -6 : 5))
            .rotationEffect(.degrees(floating ? 0.7 : -0.7))
            .shadow(color: TimiColor.blue.opacity(0.18), radius: 18, y: 12)
            .animation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true), value: floating)
            .onAppear { floating = true }
            .accessibilityLabel("A German Shepherd surrounded by live veterinary clinic responses")
    }
}

struct Eyebrow: View {
    var text: String
    var color: Color = TimiColor.coral
    var body: some View { Text(text.uppercased()).font(.system(size: 11, weight: .black)).tracking(1.6).foregroundStyle(color) }
}

/// The serif display headline every screen opens with, sized for the room it
/// actually has. The sizes used to be hard-coded (38–45pt) with no way down,
/// which clipped on narrow widths and wastes half a fold-open screen's
/// height; wrapping is still the first resort, scaling the last.
struct DisplayHeadline: View {
    var text: String
    var size: CGFloat = 40
    var alignment: TextAlignment = .leading
    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .bold, design: .serif))
            .foregroundStyle(TimiColor.ink)
            .multilineTextAlignment(alignment)
            .lineLimit(4)
            .minimumScaleFactor(0.65)
    }
}

/// The route-change transition, defined once so every screen changes hands
/// the same way. The *container* only fades now — and on a deliberate delay,
/// which is what makes the element choreography actually visible. The first
/// version of `timiMorph` failed for two reasons this shape fixes: the
/// incoming screen's opaque canvas appeared instantly *above* the outgoing
/// one, hiding its exit entirely on forward navigation; and each element
/// carried a fast fade, so it vanished before it had visibly moved. So:
/// the outgoing screen stays fully opaque while its elements fly off
/// (`TimiMorph.exitDuration`), the incoming screen holds back until that
/// flight has mostly played, and only then does it appear and send its own
/// elements in.
enum TimiScreenChange {
    // Apple-only refinements stay behind the platform gate, matching this
    // module's rule that an unproven Skip surface never ships blind: Android
    // keeps the plain crossfade, which is the half that fixed the tracker's
    // double-rendered headline.
    #if os(Android)
    static let transition: AnyTransition = .opacity
    #else
    static let transition: AnyTransition = .asymmetric(
        // Held invisible while the outgoing elements are mid-flight, then a
        // quick reveal just before this screen's own elements fly in.
        insertion: AnyTransition.opacity.animation(.easeOut(duration: 0.16).delay(TimiMorph.exitDuration - 0.08)),
        // Opaque for the whole exit flight, then gone. The delay is the
        // entire trick: fading during the flight is what made the first
        // version read as a plain crossfade.
        removal: AnyTransition.opacity.animation(.easeIn(duration: 0.2).delay(TimiMorph.exitDuration + 0.15))
    )
    #endif
    static let animation: Animation = .spring(response: 0.32, dampingFraction: 0.88)
}

/// Element-level screen choreography: give each major block of a screen an
/// index, and on a route (or step) change the old blocks fly fully off the
/// screen in alternating directions — no fade, a real exit — and then the
/// new screen's blocks fly in from off-screen one after another.
///
/// Built on `.offset` rather than `.move` for the same reason as
/// `TimiScreenChange`: offset is a render-time translation, so nothing is
/// re-laid-out against a different safe area mid-flight — which is exactly
/// the bug class that once doubled the tracker headline into the status bar.
/// Deliberately no `.opacity` in either direction: an element that fades
/// while it moves 80 points reads as a dissolve; one that stays solid while
/// it crosses 820 points reads as flight, which is the ask.
enum TimiMorph {
    #if os(Android)
    static func transition(_ index: Int) -> AnyTransition { .opacity }
    static let exitDuration = 0.0
    #else
    /// How long the outgoing elements' flight lasts. The container fade and
    /// the incoming elements' delays are all timed off this one number.
    static let exitDuration = 0.30

    /// 820pt clears the widest layout this app produces (980pt capped
    /// columns, measured from center), so every element genuinely leaves
    /// the screen rather than stopping near the edge.
    static func transition(_ index: Int) -> AnyTransition {
        let dx: CGFloat = index % 2 == 0 ? -1 : 1
        let drift: CGFloat = index % 3 == 0 ? -36 : 42
        return .asymmetric(
            // Waits out the exit flight, then flies in from the opposite
            // side the outgoing element left toward, one block after
            // another top to bottom.
            insertion: AnyTransition.offset(x: dx * 820, y: drift)
                .animation(.spring(response: 0.5, dampingFraction: 0.88).delay(exitDuration + 0.02 + Double(index) * 0.05)),
            removal: AnyTransition.offset(x: -dx * 820, y: -drift)
                .animation(.easeIn(duration: exitDuration).delay(Double(index) * 0.025))
        )
    }
    #endif
}

/// Reads iOS's own "Reduce Motion" accessibility setting (Settings →
/// Accessibility → Motion) and substitutes a plain crossfade for the flight
/// transitions above. This is not a stylistic fallback — Reduce Motion exists
/// specifically for vestibular disorders, where a 820pt full-screen flight on
/// every navigation is not merely unwanted but can trigger real physical
/// symptoms (WCAG 2.3.3, Animation from Interactions). A `ViewModifier`
/// rather than a plain function because it needs `@Environment`, which is
/// unavailable to the static properties on `TimiMorph`/`TimiScreenChange`
/// themselves; every existing `.timiMorph(_:)` call site picks this up with
/// no change, and it stays reactive if the setting changes mid-session.
private struct TimiMorphModifier: ViewModifier {
    // Android's TimiMorph.transition is already the plain `.opacity` crossfade
    // (see the enum above), so there is nothing to reduce there — and reading
    // `accessibilityReduceMotion` is an unproven Skip surface this module's
    // own rule (stated on TimiTabBar's `highlightNamespace`, among others)
    // says not to ship blind. Apple-only, like every other refinement here.
    #if !os(Android)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #endif
    let index: Int
    func body(content: Content) -> some View {
        #if os(Android)
        content.transition(TimiMorph.transition(index))
        #else
        content.transition(reduceMotion ? AnyTransition.opacity.animation(.easeInOut(duration: 0.18)) : TimiMorph.transition(index))
        #endif
    }
}

private struct TimiScreenTransitionModifier: ViewModifier {
    #if !os(Android)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #endif
    func body(content: Content) -> some View {
        #if os(Android)
        content.transition(TimiScreenChange.transition)
        #else
        content.transition(reduceMotion ? AnyTransition.opacity.animation(.easeInOut(duration: 0.18)) : TimiScreenChange.transition)
        #endif
    }
}

extension View {
    /// Tag a screen's nth major block for the morph. Indices start at 0 from
    /// the top of the screen; they set the stagger order and the direction.
    func timiMorph(_ index: Int) -> some View {
        modifier(TimiMorphModifier(index: index))
    }

    /// The container-level counterpart to `timiMorph`, for the four top-level
    /// route transitions in `CustomerRootView`. See `TimiMorphModifier` for
    /// why this reads Reduce Motion instead of the static `TimiScreenChange.transition`.
    func timiScreenTransition() -> some View {
        modifier(TimiScreenTransitionModifier())
    }
}

/// Tími's own tab bar: a floating white capsule with the 2pt ink border and
/// hard offset shadow every card in the app carries, in place of the system
/// bar's translucent grey. The active tab is a coral pill with its label;
/// inactive tabs are quiet ink glyphs. Pure shapes and stacks — nothing here
/// is UIKit, so the same bar renders through Skip on Android.
struct TimiTabBar: View {
    @Binding var selection: Int
    // The coral pill's shared identity across tabs — matchedGeometryEffect
    // interpolates its frame from the old tab to the new one, which is what
    // makes the highlight *slide* (growing and shrinking with each label's
    // width on the way) instead of vanishing here and appearing there.
    // Apple-only, like every unproven Skip surface: Android keeps the
    // instant swap, which was the previous behavior everywhere.
    #if !os(Android)
    @Namespace var highlightNamespace
    #endif

    static let items: [(Int, String, String)] = [
        (0, "cross.case.fill", "Care"),
        (1, "pawprint.fill", "Pets"),
        (2, "clock.arrow.circlepath", "Activity"),
        (3, "gearshape.fill", "Settings")
    ]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Self.items, id: \.0) { item in
                tab(item.0, icon: item.1, label: item.2)
            }
        }
        .padding(6)
        .background(
            Capsule().fill(Color.white)
                .overlay(Capsule().stroke(TimiColor.ink, lineWidth: 2))
                .shadow(color: TimiColor.ink.faded(0.9), radius: 0, x: 4, y: 5)
        )
        .animation(.spring(response: 0.32, dampingFraction: 0.74), value: selection)
        // One hand's reach on a phone, and never a room-wide plank on a
        // fold-open or landscape width: the bar caps itself and floats
        // centered, inside the safe area rather than painted over it.
        .frame(maxWidth: 440)
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    private func tab(_ index: Int, icon: String, label: String) -> some View {
        let selected = selection == index
        // Unselected tabs are fixed-width icons; only the selected one
        // expands. Giving all four equal flexible widths — the previous
        // layout — left the active pill ~85pt on a phone, which truncated
        // "Activity" and "Settings" to "Activ…" / "Setti…".
        return Button { selection = index } label: {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 16, weight: .bold))
                if selected {
                    Text(label).font(.system(size: 12, weight: .black)).lineLimit(1).minimumScaleFactor(0.75)
                }
            }
            .foregroundStyle(selected ? Color.white : TimiColor.ink.faded(0.55))
            .padding(.horizontal, CGFloat(selected ? 14 : 0))
            .frame(minWidth: 54, minHeight: 46)
            .frame(maxWidth: selected ? .infinity : CGFloat(54))
            .background(highlight(selected))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// The coral pill (fill and ink stroke together, so the border travels
    /// with it) behind whichever tab is selected.
    @ViewBuilder private func highlight(_ selected: Bool) -> some View {
        if selected {
            #if os(Android)
            Capsule().fill(TimiColor.coral)
                .overlay(Capsule().stroke(TimiColor.ink, lineWidth: 2))
            #else
            Capsule().fill(TimiColor.coral)
                .overlay(Capsule().stroke(TimiColor.ink, lineWidth: 2))
                .matchedGeometryEffect(id: "timi-tab-highlight", in: highlightNamespace)
            #endif
        }
    }
}

/// Clearance the tab screens' scroll content needs so the last card ends
/// above the floating bar rather than behind it. Android-only now: on Apple
/// platforms the bar sits in the safe area (`safeAreaInset` in
/// CustomerRootView), which insets every scroll view automatically.
enum TimiTabBarMetrics {
    static let scrollClearance: CGFloat = 112
}

/// Sends resignFirstResponder app-wide, so the keyboard starts leaving NOW
/// rather than whenever focus happens to move. The intake flow calls this
/// before its step morph: with the keyboard still up, the morph and the
/// keyboard's own dismissal animation ran at once and cancelled each other
/// out visually.
enum TimiKeyboard {
    static func dismiss() {
        #if !SKIP && canImport(UIKit)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }
}

extension View {
    /// Bottom clearance for a tab screen's scroll content.
    ///
    /// The fixed 112pt pad this replaces was why every tab screen scrolled
    /// by about a tab bar's height even when its content fit the display:
    /// the pad itself was the overflow. With the bar in the safe area, the
    /// scroll view is already inset by exactly the bar's height, so all the
    /// content needs is ordinary breathing room. Android keeps the fixed
    /// clearance until Skip proves `safeAreaInset`.
    func timiTabScrollClearance() -> some View {
        #if os(Android)
        padding(.bottom, TimiTabBarMetrics.scrollClearance)
        #else
        padding(.bottom, 8)
        #endif
    }

    /// A screen whose content fits its height should not scroll at all —
    /// not rubber-band, not drift a tenth of a screen. Content taller than
    /// the display scrolls exactly as before.
    func timiScrollFits() -> some View {
        #if os(Android)
        self
        #else
        scrollBounceBehavior(.basedOnSize)
        #endif
    }
}

/// The app's switch: an ink-bordered track that fills coral when on, with a
/// hard-bordered white thumb — in place of the system toggle's grey pill,
/// which was the last piece of stock chrome on the settings and consent rows.
///
/// A Button rather than a `ToggleStyle` conformance on purpose: the built-in
/// toggle styles bridge through Skip, but a custom `makeBody` is an unproven
/// surface on the Android side of this module, and a switch is small enough
/// to just draw.
struct TimiToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) { isOn.toggle() }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? TimiColor.coral : TimiColor.canvas)
                    .overlay(Capsule().stroke(TimiColor.ink, lineWidth: 2))
                Circle().fill(Color.white)
                    .overlay(Circle().stroke(TimiColor.ink, lineWidth: 2))
                    .padding(4)
            }
            .frame(width: 58, height: 34)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isOn ? "On" : "Off")
    }
}

/// A labelled row with a TimiToggle on the trailing edge — the shape every
/// settings and consent row shares. The whole row is the hit target.
struct TimiToggleRow: View {
    var title: String
    var subtitle: String?
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) { isOn.toggle() }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).foregroundStyle(TimiColor.ink).multilineTextAlignment(.leading)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(TimiColor.muted).multilineTextAlignment(.leading) }
                }
                Spacer(minLength: 8)
                TimiToggle(isOn: $isOn)
                    // The row itself is the Button now; the switch's own tap
                    // target and accessibility element would otherwise nest
                    // inside it and offer a second, redundant activation.
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .timiToggleAccessibility(label: subtitle.map { "\(title). \($0)" } ?? title, isOn: isOn)
    }
}

extension View {
    /// Exposes a tap-to-toggle row as one combined element — a real name,
    /// its on/off value, and the button trait — instead of a bare tap
    /// gesture, which VoiceOver and Switch Control cannot reliably activate.
    func timiToggleAccessibility(label: String, isOn: Bool) -> some View {
        accessibilityElement(children: .combine)
            .accessibilityLabel(label)
            .accessibilityValue(isOn ? "On" : "Off")
            .accessibilityAddTraits(.isButton)
    }
}

/// Segmented choice in the app's own hand — capsule chips instead of the
/// system's grey segmented picker. Scrolls sideways rather than squeezing
/// when the labels outgrow a narrow screen.
struct TimiSegmentChips: View {
    /// (value, title) pairs, matching the tuple-list idiom the intake
    /// symptom grid already uses.
    var options: [(String, String)]
    @Binding var selection: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options, id: \.0) { option in
                    chip(option.0, title: option.1)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func chip(_ value: String, title: String) -> some View {
        let selected = selection == value
        return Button {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) { selection = value }
        } label: {
            Text(title)
                .font(.system(size: 13, weight: .black))
                .foregroundStyle(selected ? Color.white : TimiColor.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .background(Capsule().fill(selected ? TimiColor.blue : Color.white))
                .overlay(Capsule().stroke(selected ? TimiColor.ink : TimiColor.ink.faded(0.2), lineWidth: CGFloat(selected ? 2 : 1)))
        }.buttonStyle(.plain)
    }
}

/// The app's stepper: round ink-bordered minus/plus plates around a serif
/// count, replacing the system `Stepper`'s grey capsule.
struct TimiStepper: View {
    @Binding var value: Int
    var lowerBound = 1
    var upperBound = 12
    var label: String

    var body: some View {
        HStack(spacing: 14) {
            stepButton("minus", enabled: value > lowerBound) { value = max(lowerBound, value - 1) }
            Text(label)
                .font(.system(size: 20, weight: .bold, design: .serif))
                .foregroundStyle(TimiColor.ink)
                .frame(maxWidth: .infinity)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            stepButton("plus", enabled: value < upperBound) { value = min(upperBound, value + 1) }
        }
        .padding(8)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(TimiColor.ink, lineWidth: 2))
    }

    private func stepButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .black))
                .foregroundStyle(enabled ? Color.white : TimiColor.muted)
                .frame(width: 40, height: 40)
                .background(enabled ? TimiColor.blue : TimiColor.canvas, in: Circle())
                .overlay(Circle().stroke(TimiColor.ink.faded(enabled ? 1 : 0.3), lineWidth: 2))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// A Tími-styled "are you sure" card over a dimmed screen — used before
/// leaving the tracker and before abandoning an active search, where one
/// stray tap used to throw the screen away instantly. Deliberately not the
/// system confirmationDialog: this is the one moment the app most needs to
/// sound like itself. The dim itself answers "stay", so a tap anywhere
/// outside the card is the safe choice.
struct TimiConfirmCard: View {
    var title: String
    var message: String
    var stayLabel: String
    var leaveLabel: String
    var onStay: () -> Void
    var onLeave: () -> Void

    var body: some View {
        ZStack {
            TimiColor.ink.faded(0.44).ignoresSafeArea()
                .onTapGesture { onStay() }
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.system(size: 27, weight: .bold, design: .serif))
                    .foregroundStyle(TimiColor.ink)
                    .minimumScaleFactor(0.8)
                Text(message).font(.callout).foregroundStyle(TimiColor.muted)
                Button(stayLabel) { onStay() }.buttonStyle(TimiPrimaryButtonStyle()).padding(.top, 6)
                Button(leaveLabel) { onLeave() }.buttonStyle(TimiQuietButtonStyle())
            }
            .frame(maxWidth: 360)
            .timiCard(Color.white)
            .padding(24)
        }
    }
}

struct PulsingBeacon: View {
    @State var pulse = false
    var symbol = "pawprint.fill"
    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle().stroke(TimiColor.blue.faded(0.26 - Double(index) * 0.06), lineWidth: 2)
                    .frame(width: CGFloat(104 + index * 44), height: CGFloat(104 + index * 44))
                    .scaleEffect(CGFloat(pulse ? 1.12 : 0.86)).opacity(Double(pulse ? 0.18 : 0.9))
                    .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false).delay(Double(index) * 0.22), value: pulse)
            }
            Circle().fill(TimiColor.blue).frame(width: 92, height: 92).overlay(Image(systemName: symbol).font(.system(size: 37, weight: .bold)).foregroundStyle(.white))
                .overlay(Circle().stroke(TimiColor.ink, lineWidth: 3)).shadow(color: TimiColor.ink.opacity(0.3), radius: 0, x: 5, y: 6)
        }.frame(height: 230).onAppear { pulse = true }.accessibilityHidden(true)
    }
}

struct ProgressPills: View {
    var current: Int
    var total: Int
    var body: some View {
        HStack(spacing: 7) { ForEach(0..<total, id: \.self) { i in Capsule().fill(i <= current ? TimiColor.coral : TimiColor.ink.faded(0.12)).frame(width: CGFloat(i == current ? 30 : 8), height: 8).animation(.spring(response: 0.35), value: current) } }
    }
}

struct MetricChip: View {
    var title: String; var value: String; var color: Color = TimiColor.blueSoft
    var body: some View { VStack(alignment: .leading, spacing: 5) { Text(title.uppercased()).font(.system(size: 9, weight: .black)).foregroundStyle(TimiColor.muted); Text(value).font(.system(size: 17, weight: .black)).foregroundStyle(TimiColor.ink) }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(color, in: RoundedRectangle(cornerRadius: 14)) }
}

/// "Do not wait for an app response" — and then nothing to press.
///
/// The notice was right and useless: it told somebody whose animal may be
/// dying to go to an emergency hospital, on a screen that knew where they
/// were and which hospitals take emergencies, and made them find one
/// themselves. Given a store it now offers the list.
///
/// Without one — the onboarding screen, which runs before location
/// permission exists — it stays the notice it was.
struct SafetyBanner: View {
    var compact = false
    var store: AppStore?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "cross.case.fill").foregroundStyle(.white).frame(width: 34, height: 34).background(TimiColor.coral, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text("Possible emergency?").font(.headline)
                    Text(message).font(.caption).foregroundStyle(TimiColor.muted)
                }
            }
            if let store {
                Button { Task { await store.findEmergencyCare() } } label: {
                    HStack(spacing: 8) {
                        if store.isFindingEmergency { ProgressView().tint(.white) }
                        // Short, and allowed to shrink rather than clip: the
                        // first label was long enough to overflow the button
                        // and render with both ends cut off.
                        Text(store.isFindingEmergency ? "Finding hospitals…" : "Emergency care now")
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        Image(systemName: "arrow.right")
                    }
                }
                .buttonStyle(TimiPrimaryButtonStyle())
                .disabled(store.isFindingEmergency)
            }
        }
        .padding(14)
        .background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(TimiColor.coral.faded(0.45)))
    }

    private var message: String {
        if store != nil {
            return compact
                ? "Don't wait for a clinic to answer — go straight to an emergency hospital."
                : "If your pet may be in immediate danger, go straight to an emergency hospital and have someone call ahead."
        }
        return compact
            ? "Do not wait for an app response."
            : "If your pet may be in immediate danger, leave for the nearest emergency-capable hospital while someone calls ahead."
    }
}

/// The answer to that button: the nearest emergency-capable hospitals, with a
/// phone number and directions on each. No request is sent, no clinic is asked
/// to accept, and nothing here waits for anybody — it is a list of places to
/// drive to.
struct EmergencyCareSheet: View {
    @Bindable var store: AppStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Go now. Call from the car if you can — most emergency hospitals want to know an animal is on the way.")
                        .font(.callout).foregroundStyle(TimiColor.muted)

                    if store.isFindingEmergency {
                        HStack(spacing: 10) { ProgressView(); Text("Finding the nearest emergency hospitals…").font(.callout).fontWeight(.semibold) }
                            .frame(maxWidth: .infinity).padding(.vertical, 30)
                    }

                    if let error = store.emergencyError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout).foregroundStyle(TimiColor.coral)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 14))
                    }

                    ForEach(store.emergencyLocations) { place in
                        EmergencyClinicRow(store: store, place: place)
                    }

                    // The Worker's words, not a restatement: most of this list
                    // is third-party map data and the caveat has to be the same
                    // on every surface.
                    if let notice = store.emergencyNotice, !notice.isEmpty {
                        Text(notice).font(.caption).foregroundStyle(TimiColor.muted)
                    }
                    Text("Tími does not diagnose or triage. This is a list of the emergency-capable hospitals nearest to you; it is not advice about whether to go.")
                        .font(.caption).foregroundStyle(TimiColor.muted)
                }.padding(20)
            }
            .background(TimiColor.canvas)
            .navigationTitle("Emergency care")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { store.showEmergencyList = false } }
            }
        }
    }
}

struct EmergencyClinicRow: View {
    @Bindable var store: AppStore
    var place: EmergencyPlace
    @State var showNavigation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(place.name).font(.title3).fontWeight(.black)
                Spacer()
                // Worth marking: a partner is the only kind Tími can actually
                // send a request to.
                if place.partner {
                    Text("TÍMI").font(.system(size: 9, weight: .black)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 4)
                        .background(TimiColor.blue, in: Capsule())
                }
            }
            Text(subtitle).font(.caption).fontWeight(.bold).foregroundStyle(TimiColor.coral)
            if let address = place.address, !address.isEmpty {
                Text(address).font(.callout).foregroundStyle(TimiColor.muted)
            }
            StaffingNotice(notice: place.staffingNotice)
            HStack(spacing: 10) {
                if let url = telephoneURL {
                    Link(destination: url) { Label("Call", systemImage: "phone.fill") }
                        .buttonStyle(TimiPrimaryButtonStyle())
                }
                // Tími's own navigation when this build has it, which is the
                // point: an emergency hospital found on a map is still a place
                // we can drive somebody to, and leaving the app was never a
                // decision anybody made on purpose.
                // Also gated on the token: without one there is no route to
                // draw, and offering Navigate only to land on Apple Maps is a
                // worse answer than offering Apple Maps.
                if TurnByTurn.isAvailable, !(store.mapToken ?? "").isEmpty, place.navigationDestination != nil {
                    Button { showNavigation = true } label: {
                        Label("Navigate", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                    }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
                }
            }
            // Apple Maps stays reachable on this screen specifically.
            //
            // Everywhere else it is what happens when our navigation is absent.
            // Here it is a deliberate second door, because this is the screen
            // somebody opens when an animal is in trouble: Maps may already be
            // running in CarPlay, it holds their own routing preferences, and
            // it keeps working if this app does not. Quiet rather than primary
            // — ours is the offer, this is the escape hatch.
            if let url = directionsURL {
                if TurnByTurn.isAvailable, !(store.mapToken ?? "").isEmpty {
                    Link(destination: url) { Label("Open in Maps instead", systemImage: "map.fill") }
                        .buttonStyle(TimiQuietButtonStyle())
                } else {
                    Link(destination: url) { Label("Directions", systemImage: "map.fill") }
                        .buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
                }
            }
            if place.phone == nil {
                Text("No phone number is listed for this hospital.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .timiCard(Color.white)
        // fullScreenCover does not exist on macOS, which is only ever the host
        // `swift test` builds for — the same split the arrival tracker makes.
        #if os(macOS)
        .sheet(isPresented: $showNavigation) { navigationCover }
        #else
        .fullScreenCover(isPresented: $showNavigation) { navigationCover }
        #endif
    }

    @ViewBuilder private var navigationCover: some View {
        if let destination = place.navigationDestination {
            NavigationScreen(
                store: store,
                destination: destination,
                // Nothing about this drive is calm, and there may be no care
                // draft at all behind it.
                tone: .emergency,
                // No intake here, and possibly an intake for somewhere else.
                recordsArrival: false,
                onFinish: { showNavigation = false }
            )
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let miles = place.distanceMiles { parts.append(String(format: "%.1f mi away", miles)) }
        if let label = place.availabilityLabel, !label.isEmpty {
            parts.append(label)
        } else if place.emergencyNamed == true {
            parts.append("Listed as emergency care")
        } else {
            // Padding the list with a day clinic is better than an empty
            // screen, but calling it an emergency hospital would not be.
            parts.append("Veterinary clinic — call to ask about emergencies")
        }
        return parts.joined(separator: " · ")
    }

    private var telephoneURL: URL? {
        guard let phone = place.phone else { return nil }
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }

    /// The same builder the navigation fallback uses, rather than a second
    /// copy of the URL that only happens to match it.
    private var directionsURL: URL? {
        guard let latitude = place.latitude, let longitude = place.longitude else { return nil }
        return AppleMapsFallback.directionsURL(latitude: latitude, longitude: longitude, name: place.name)
    }
}

/// Shown wherever a technician-staffed provider appears — an offer, an
/// emergency result, a confirmed clinic.
///
/// A veterinary technician works under a veterinarian's supervision and cannot
/// diagnose, prognose, prescribe, or perform surgery, so which one is on the
/// floor changes what an offer can mean. The wording comes from the Worker so
/// it is identical everywhere and cannot be edited per screen.
struct StaffingNotice: View {
    var notice: String?
    var body: some View {
        if let notice, !notice.isEmpty {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "stethoscope").foregroundStyle(TimiColor.ink).accessibilityHidden(true)
                Text(notice).font(.caption).fontWeight(.semibold).foregroundStyle(TimiColor.ink)
            }
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TimiColor.goldSoft, in: RoundedRectangle(cornerRadius: 13))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(TimiColor.gold))
        }
    }
}

struct ErrorToast: View {
    var message: String
    var dismiss: () -> Void
    var body: some View {
        HStack { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(TimiColor.gold).accessibilityHidden(true); Text(message).font(.callout).fontWeight(.semibold); Spacer(); Button(action: dismiss) { Image(systemName: "xmark") }.accessibilityLabel("Dismiss") }
            .padding().background(TimiColor.ink, in: RoundedRectangle(cornerRadius: 16)).foregroundStyle(.white).padding(.horizontal)
    }
}

struct CelebrationOverlay: View {
    @State var expand = false
    var body: some View {
        ZStack {
            Color.black.faded(Double(expand ? 0 : 0.08)).ignoresSafeArea()
            ForEach(0..<18, id: \.self) { i in
                Circle().fill(i % 3 == 0 ? TimiColor.coral : (i % 3 == 1 ? TimiColor.gold : TimiColor.blue)).frame(width: 10, height: 10)
                    .offset(x: CGFloat(expand ? (i % 6 - 3) * 58 : 0), y: CGFloat(expand ? (i / 6 - 1) * 170 : 0)).opacity(Double(expand ? 0 : 1))
                    .animation(.easeOut(duration: 1.0).delay(Double(i % 5) * 0.03), value: expand)
            }
            Image(systemName: "checkmark").font(.system(size: 44, weight: .black)).foregroundStyle(.white).frame(width: 94, height: 94).background(TimiColor.blue, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 3)).scaleEffect(CGFloat(expand ? 1.08 : 0.3)).animation(.spring(response: 0.46, dampingFraction: 0.58), value: expand)
        }.allowsHitTesting(false).onAppear { expand = true }
    }
}
