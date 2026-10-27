# Map builder

The map builder edits [fpvsim-map packages](MAP_FORMAT.md) inside the simulator: race courses,
freestyle spots and research ranges. You fly them with the real physics and Betaflight a click
later. Open it from the menu: **Build**. Start from a template, a draft, a community map or Bando,
or import a `.zip` or a folder.

Drafts save in this browser as you work. **Export** writes a package that the repository's validator
accepts. **Publish** puts it on the user-map service.

It is laid out and driven like the Unity and Unreal editors, so the habits carry over.

| Panel | Unity / Unreal | What it does |
| --- | --- | --- |
| **Top bar** | toolbar, Play | Undo / redo / history, **Fly** (play the map), Validate, Export, Publish, panel toggles, shortcuts (`?`), exit |
| **Place** (left) | Project window / Content Browser, Place Actors | rendered thumbnails of every gate, primitive and prefab, and tiles for spawns, lights, zones, trees and actors; a search across all of them; the tool settings (gate size, primitive look, prefab parameters, tree brush, terrain sculpting) |
| **Viewport** | Scene view / level viewport | the map as it flies, with gizmos, a reference grid, the viewport toolbar and the axis gizmo |
| **Outliner** (right, top) | Hierarchy / World Outliner | every object in a tree: courses with their gates in lap order, the start, groups, primitives, trees, lights, zones, actors, meshes, paths |
| **Details** (right, bottom) | Inspector / Details | the selection's properties: a Transform section, then Properties; the map's settings when nothing is selected |
| **Problems / History** (bottom) | Console / Undo History | validator messages, race-course checks and budget meters; every undo step |
| **Status bar** | status bar | what the mouse buttons do now, the ground under the cursor, the selection, errors, frame rate, save state |

Drag a panel's edge to resize it; double-click the edge for its default size. The top bar's panel
buttons hide and show the docks. Sizes, folded sections, the Show menu, snapping and the camera
settings are kept in this browser.

## Camera

| Input | Does |
| --- | --- |
| Right-drag | look around |
| Hold right + **W A S D**, **Q / E** | fly; Shift is faster; the wheel sets the fly speed |
| Alt + left-drag | orbit round the view centre |
| Middle-drag | pan |
| Wheel | zoom toward the point under the cursor |
| **F** / **Home** | frame the selection / the whole map |
| Axis gizmo | click an axis to look along it; click the centre to switch perspective / orthographic |
| Num 7 / 1 / 3 / 5 | top / north / east view; perspective ↔ orthographic |
| Arrows, Page Up / Down | with nothing selected: move the view |

The **Camera** menu can switch right-drag to orbiting, and sets the fly speed. The **View** menu
picks the projection and the axis views. **Top, orthographic** is the plan view for laying out a
course. A gamepad flies the camera too: left stick moves, right stick looks, triggers go down / up.

## Selecting and editing

| Input | Does |
| --- | --- |
| Click | select; Shift / Ctrl click adds or removes |
| Left-drag on the view | box select; Shift adds, Ctrl removes |
| Double-click | select and frame |
| Alt + click | one part of a group (a prefab's single box) |
| **Q W E R** (or 1 2 3 4) | select, move, rotate, scale |
| **X** | gizmo in world or object axes |
| **G** | snapping on / off; the grid and angle steps are on the viewport toolbar |
| Arrows, Page Up / Down | nudge the selection a grid step (Shift: ×10), up / down |
| **[ ]** | turn the selection by the angle step |
| **End** | drop to the ground |
| Ctrl+C / X / V | copy, cut, paste. Ctrl+V pastes at the cursor, keeping each object's height above the ground; the menu's **Paste here** pastes at the clicked point. The clipboard works across drafts. |
| Ctrl+D | duplicate |
| Delete | delete |
| Ctrl+A | select all |
| Ctrl+G / Ctrl+Shift+G | group / ungroup |
| F2 | rename (spawns, actors, groups, courses, paths) |
| **H** / Shift+H / Alt+H | hide the selection / isolate it / show everything |
| Ctrl+Z / Ctrl+Y | undo / redo |
| Ctrl+S | save now |
| Alt+P | fly the map |
| ? | the shortcut sheet |

Right-click without dragging opens the **context menu**. It holds the edit commands for the
selection and **Add here** for a gate, box, spawn pad, light or tree at that point. Place panel
tiles can also be dragged straight onto the view.

### The outliner

Click a row to select, Shift / Ctrl click to add, and double-click (or Enter) to frame. The arrow
keys walk the rows, Left / Right fold folders, and F2 renames. Each row has an **eye** (hide) and a
**lock**: a locked object can't be picked or box-selected in the view, but can still be selected in
the outliner. A folder's eye and lock act on everything in it. The search filters by name and kind.

Hiding and locking only affect the editor's view. They are not saved in the map, and they reset when
the page reloads. Groups are saved, as `x-group` on their members and their name in `x-builder.names`.

### The details panel

A field changes every selected object at once. Differing values show as `—`, and a new value sets
them all. Drag a number's label sideways to scrub it, as in Unity (Shift: faster, Alt: finer); one
drag is one undo step. Position fields carry X / Y / Z tags (red, green, blue), which scrub that
axis. Sections fold, and stay folded.

### History

**History** in the bottom dock lists every step since the draft was opened, newest last. Click a
step to undo or redo to it.

## Viewport toolbar and Show menu

- **Transform tools:** select, move, rotate and scale.
- **World / Local:** the gizmo's axes.
- **Snapping:** the magnet turns it on or off, next to the grid step and the angle step.
- **Camera menu:** right-drag mode and fly speed.
- **View menu:** perspective or orthographic, and the axis views.
- **Show menu**, each one on or off:
  - the grid;
  - labels;
  - gizmos (spawns, lights, zones, actors, paths);
  - the racing line;
  - collision shapes (the pick and collision proxies of primitives, gates, trees and meshes, as
    wireframes).

The grid's minor lines follow the snap step and its major lines fall every ten. The red line is
east (x) and the green line is north (y), matching the X and Y fields.

Code: [`src/editor/`](../src/editor/):
- `editor.ts`: the editor;
- `layout.ts`: the docks;
- `viewport.ts`: the toolbar, axis gizmo, menus, status bar and shortcuts;
- `outliner.ts`, `ui.ts`: the panels;
- `camera.ts`, `grid.ts`, `thumbs.ts`, `clipboard.ts`, `prefs.ts`.

Tests: [`tests/editorTools.test.ts`](../tests/editorTools.test.ts) and
[`tests/editorDoc.test.ts`](../tests/editorDoc.test.ts).
