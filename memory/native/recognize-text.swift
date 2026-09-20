import Foundation
import Vision

struct Candidate: Encodable { let text: String; let confidence: Float }
struct Line: Encodable { let box: [Double]; let candidates: [Candidate] }
struct Result: Encodable {
    let revision: Int
    let durationMs: Double
    let lines: [Line]
    let error: String?
    enum CodingKeys: String, CodingKey { case revision, durationMs, lines, error }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(revision, forKey: .revision)
        try container.encode(durationMs, forKey: .durationMs)
        try container.encode(lines, forKey: .lines)
        try container.encode(error, forKey: .error) // Explicit null on success.
    }
}

let started = DispatchTime.now().uptimeNanoseconds
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
request.minimumTextHeight = 0.005
var lines: [Line] = []
var failure: String? = nil
if CommandLine.arguments.count != 2 {
    failure = "invalid_arguments"
} else {
    do {
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        try VNImageRequestHandler(url: url, options: [:]).perform([request])
        let observations = request.results ?? []
        if observations.count > 200 {
            failure = "line_limit"
        } else {
            for observation in observations {
                let candidates = observation.topCandidates(3)
                if candidates.contains(where: { $0.string.utf16.count > 1000 }) {
                    failure = "text_limit"
                    break
                }
                let box = observation.boundingBox
                lines.append(Line(box: [box.minX, box.minY, box.width, box.height], candidates:
                    candidates.map { Candidate(text: $0.string, confidence: $0.confidence) }))
            }
        }
    } catch {
        // Do not return localized errors containing private image paths.
        failure = "recognition_failed"
    }
}
if failure != nil { lines = [] }
let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
let result = Result(revision: request.revision, durationMs: elapsed, lines: lines, error: failure)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let bytes = try? encoder.encode(result), let text = String(data: bytes, encoding: .utf8) {
    print(text)
} else {
    exit(1)
}
