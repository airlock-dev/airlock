import SwiftUI

struct RequestDetailView: View {
    let request: ApprovalRequest
    let onApprove: () -> Void
    let onDeny: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(request.tool)
                        .font(.system(size: 18, weight: .semibold))
                    Text(request.agentId)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text(request.code)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
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
                        ForEach(request.args.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
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
                    .padding(.trailing, 2)
                }
            }

            HStack(spacing: 10) {
                Button("Deny") {
                    onDeny()
                    dismiss()
                }
                .buttonStyle(.bordered)

                Button("Approve") {
                    onApprove()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(20)
        .frame(width: 620, height: 520)
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
