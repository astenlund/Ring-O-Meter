# Visual vocabulary

The set of pen gestures sketch-brainstorm recognises deterministically. Marking up the rendered mockup with these gestures lets the user communicate common edit operations without writing English instructions.

The vocabulary is small by design: every additional gesture raises the discoverability tax. Extensions should land only when a gesture is repeatedly substituted for a longer English instruction.

Two tiers:

- **Global vocabulary** (this file) travels with the skill across machines and projects.
- **Project-local extensions** live at `.claude/sketch-brainstorm-vocab.md` in the host project and are merged into the global vocabulary on session launch (project entries override on conflict).

## Core vocabulary

| Gesture                                                  | Meaning                          |
| -------------------------------------------------------- | -------------------------------- |
| Arrow from A to B                                        | Move A to B                      |
| Plus sign next to an element                             | Make element slightly larger     |
| Two plus signs (`++`) next to an element                 | Make element much larger         |
| Minus / short dash next to an element                    | Make element slightly smaller    |
| Two minuses (`--`) next to an element                    | Make element much smaller        |
| Strikethrough or X over an element (red disambiguates)   | Remove                           |
| New element drawn in place, or circle + text label       | Add                              |
| Grey line through or near elements                       | Align elements on the line's axis. Position = axis: through = center, near top = top-aligned, near bottom = bottom-aligned, on left/right edge = left/right-aligned. Optional letter callout near the line clarifies: `c` / `t` / `b` / `l` / `r`. |
| Squiggle inside an element                               | Lorem-ipsum text placeholder     |
| Handwritten text inside a UI element                     | UI copy for that element         |
| Handwritten text in the notes region                     | Instruction for Claude           |
| Handwritten text + arrow pointing at element             | Instruction about that element   |
| Letter callout (`a:`, `b:`, ...) near element + matching `a.`-prefixed note in the notes region | Long-form instruction tied to that element. Use when a single sentence inline in the notes would be too cramped or too far from the target. Letters are arbitrary identifiers, not ordering. The matching note may sit in the same page's notes region or in any user-added notes-only page; letter callouts are unique within an iteration. |

**Color usage.** For most gestures, color is optional emphasis: shape
carries the meaning and black ink is fine. Pen-color switching is a
flow tax, so the default expectation is one pen.

The exception is the line gestures. A horizontal line through one or
more elements is ambiguous between "remove" (strikethrough) and
"align" by shape alone, so color disambiguates: **red = Remove**,
**grey = Align**. Black or any other color on a line through elements
should be avoided.

For Add gestures, **green** is the optional emphasis when natural.

## Hardware portability

The shape-first principle means hardware that displays in monochrome (rM2) is fully equivalent to color-display hardware (Paper Pro) for the user's experience: the user can see what they're drawing in either case. Color emphasis, when used, still travels through the cloud export correctly on both devices, so the interpretation subagent reads the optional emphasis the same way regardless of which device drew it.

## Render-palette discipline (no longer needed)

An earlier draft considered reserving red, green, and grey-straight colors so the mockup region could not paint in them, on disambiguation grounds. The shape-first vocabulary above makes this unnecessary: a colored stroke in the mockup region is just rendered content, and the user's pen marks are extracted as a separate vector layer via `rmscene` rather than diffed from a flattened raster (see the feature spec's `Render: ... rmscene (inbound)` section). The mockup region renders any colors the developer chooses; legend samples render in black by default since color is now an emphasis tool, not a gesture identifier.
