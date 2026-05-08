# Visual vocabulary

The set of pen gestures sketch-brainstorm recognises deterministically. Marking up the rendered mockup with these gestures lets the user communicate common edit operations without writing English instructions.

The vocabulary is small by design: every additional gesture raises the discoverability tax. Extensions should land only when a gesture is repeatedly substituted for a longer English instruction.

Two tiers:

- **Global vocabulary** (this file) travels with the skill across machines and projects.
- **Project-local extensions** live at `.claude/sketch-brainstorm-vocab.md` in the host project and are merged into the global vocabulary on session launch (project entries override on conflict).

## Core vocabulary

| Gesture                                       | Meaning                          |
| --------------------------------------------- | -------------------------------- |
| Arrow from A to B                             | Move A to B                      |
| Red strokes (any shape)                       | Remove                           |
| Green strokes (any shape)                     | Add                              |
| Straight grey lines                           | Alignment guide                  |
| Black squiggle inside an element              | Lorem-ipsum text placeholder     |
| Handwritten text inside a UI element          | UI copy for that element         |
| Handwritten text in margins / free-text area  | Instruction for Claude           |
| Handwritten text + arrow pointing at element  | Instruction about that element   |

## Hardware portability

Color gestures (red, green, grey-straight) work on both Paper Pro and rM2. The rM2 display is monochrome but exported annotations preserve color: an rM2 user marks "blind" (cannot see their own colors while sketching) and the exported PDF carries the color through correctly.

## Render-palette discipline (considered and rejected)

An earlier draft reserved the vocabulary's red, green, and grey-straight colors so the mockup region could not paint in them. Dropped: the diff already cancels rendered content out of the stroke layer, and the user knows which strokes are theirs. The cost was forbidding faithful renders of UIs that use those colors in their own design, which is exactly what the workflow exists to support.

The mockup region renders any colors the developer chooses. Legend samples still use the canonical red / green / grey since they live in reserved chrome and are labelled as samples.
