import Foundation
import SwiftUI

struct LabNumberField: View {
    var title: String
    var value: Double
    var onChange: (Double) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if !title.isEmpty {
                Text(title).font(.system(size: 10, weight: .black)).foregroundStyle(LabColor.muted)
            }
            TextField("0", text: $text)
                .keyboardType(.numbersAndPunctuation)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .monospacedDigit()
                .onSubmit { commit() }
                .onChange(of: focused) { _, now in if !now { commit() } }
                .onAppear { text = format(value) }
                .onChange(of: value) { _, now in if !focused { text = format(now) } }
        }
    }

    private func format(_ v: Double) -> String {
        abs(v - v.rounded()) < 0.01 ? String(Int(v.rounded())) : String(format: "%.1f", v)
    }
    private func commit() {
        if let parsed = Double(text.trimmingCharacters(in: .whitespaces)) { onChange(parsed) }
        text = format(value)
    }
}

struct LabMiniButton: View {
    var title: String = ""
    var symbol: String = ""
    var wide = false
    var tint: Color = LabColor.ink
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if symbol.isEmpty {
                    Text(title).font(.system(size: 12, weight: .black))
                } else {
                    Image(systemName: symbol).font(.system(size: 13, weight: .bold))
                }
            }
            .foregroundStyle(tint)
            .frame(minWidth: wide ? nil : 34, maxWidth: wide ? .infinity : nil, minHeight: 32)
            .padding(.horizontal, wide ? 8 : 0)
            .background(RoundedRectangle(cornerRadius: 9).fill(.white)
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(tint.opacity(0.4), lineWidth: 1.5)))
        }
        .buttonStyle(.plain)
    }
}

struct LabSectionLabel: View {
    var text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 10, weight: .black)).tracking(1.4)
            .foregroundStyle(LabColor.coral)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A paint picker: the palette tokens, plus a hex field when "custom" is on.
struct LabPaintPicker: View {
    var title: String
    var paint: LabPaint
    var onChange: (LabPaint) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabSectionLabel(text: title)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 5), count: 8), spacing: 5) {
                ForEach(LabPaint.tokens, id: \.self) { token in
                    Button { onChange(LabPaint(token, hex: paint.hex)) } label: {
                        swatch(token)
                    }
                    .buttonStyle(.plain)
                }
            }
            if paint.token == "custom" {
                TextField("#RRGGBB", text: Binding(
                    get: { paint.hex },
                    set: { onChange(LabPaint("custom", hex: $0)) }
                ))
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            }
        }
    }

    private func swatch(_ token: String) -> some View {
        let chosen = token == paint.token
        return ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(token == "none" ? Color.white : LabColor.resolve(LabPaint(token, hex: paint.hex)))
            if token == "none" {
                Path { p in p.move(to: .zero); p.addLine(to: CGPoint(x: 26, y: 26)) }
                    .stroke(LabColor.coral, lineWidth: 1.5)
            }
            RoundedRectangle(cornerRadius: 6)
                .stroke(chosen ? LabColor.blue : LabColor.ink.opacity(0.3),
                        lineWidth: chosen ? 3 : 1)
        }
        .frame(height: 26)
    }
}

/// A labelled slider with a number beside it — the pairing that makes a style
/// value both nudgeable and exact.
struct LabSlider: View {
    var title: String
    var value: Double
    var range: ClosedRange<Double>
    var step: Double = 1
    var onChange: (Double) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(LabColor.muted)
                .frame(width: 62, alignment: .leading)
            Slider(value: Binding(get: { value }, set: { onChange($0) }),
                   in: range, step: step)
            Text(step < 1 ? String(format: "%.1f", value) : String(Int(value)))
                .font(.system(size: 11, weight: .black)).monospacedDigit()
                .foregroundStyle(LabColor.ink)
                .frame(width: 34, alignment: .trailing)
        }
    }
}
