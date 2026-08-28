import Testing
@testable import CompanionKit

@Test
func characterMarkCatalogHasEightBoundedClosedShapes() {
    #expect(CharacterMarkShape.allCases.count == 8)
    for shape in CharacterMarkShape.allCases {
        let commands = CharacterMarkGeometry.commands(shapeIndex: shape.rawValue)
        #expect(commands.count >= 4)
        #expect(commands.last == .close)
        for command in commands {
            let points: [CharacterMarkPoint]
            switch command {
            case .move(let point), .line(let point): points = [point]
            case .curve(let first, let second, let end): points = [first, second, end]
            case .close: points = []
            }
            for point in points {
                #expect(point.x >= -0.04 && point.x <= 1.04)
                #expect(point.y >= -0.04 && point.y <= 1.04)
            }
        }
    }
}

@Test
func characterMarkEyesArePairedObliqueStrokesInUpperThird() {
    let eyes = CharacterMarkGeometry.eyeSegments
    #expect(eyes.count == 2)
    #expect(eyes[0].start.x < eyes[1].start.x)
    for eye in eyes {
        #expect(eye.start.y < 0.40)
        #expect(eye.end.y < eye.start.y)
        #expect(eye.end.x > eye.start.x)
    }
}

@Test
func characterMarkSupportsEveryApprovedDisplaySize() {
    #expect(CharacterMarkGeometry.supportedSizes == [20, 36, 64, 80, 96])
}
