import AppKit
import SwiftUI

struct RequestDetailView: View {
    let request: ApprovalRequest
    let onApprove: () -> Void
    let onDeny: () -> Void
    let onDismiss: () -> Void
    var onNext: (() -> Void)? = nil
    var onPrev: (() -> Void)? = nil
    @Binding var argsScrollView: NSScrollView?

    private var sortedArgKeys: [String] { request.args.keys.sorted() }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                Button(action: onDismiss) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .focusEffectDisabled()

                VStack(alignment: .leading, spacing: 4) {
                    Text(request.tool)
                        .font(.system(size: 18, weight: .semibold))
                    Text(request.agentId)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack(spacing: 8) {
                    if onPrev != nil || onNext != nil {
                        Text("⇧K / ⇧J  navigate")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    Text("H  back")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(request.code)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 12) {
                detailPill(title: "Timeout", value: "\(request.timeoutMs / 1000)s")
                detailPill(title: "Args", value: "\(request.args.count)")
            }

            if request.args.isEmpty {
                Text("No arguments")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    .padding(.vertical, 32)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ScrollViewProbe(captured: $argsScrollView).frame(height: 0)

                        ForEach(sortedArgKeys, id: \.self) { key in
                            if let value = request.args[key] {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(key)
                                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                                        .foregroundStyle(.secondary)

                                    CodeBlockView(attributedText: CodeHighlighter.highlightedString(for: value))
                                        .frame(minHeight: 80, idealHeight: 120, maxHeight: 220)
                                        .background(.quaternary.opacity(0.45))
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                    .padding(.trailing, 2)
                }
            }

            ApproveRejectButtons(
                onApprove: { onApprove(); onDismiss() },
                onDeny:    { onDeny();    onDismiss() },
                fontSize: 14,
                verticalPadding: 9,
                cornerRadius: 8
            )
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func detailPill(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 12, weight: .semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.45))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - ScrollViewProbe

struct ScrollViewProbe: NSViewRepresentable {
    @Binding var captured: NSScrollView?

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            var v: NSView? = nsView.superview
            while let node = v {
                if let sv = node as? NSScrollView { captured = sv; return }
                v = node.superview
            }
        }
    }
}
