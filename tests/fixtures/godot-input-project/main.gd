extends Control
## Where each Control sits, in root-viewport pixels (the 640x360 viewport):
##   RootButton        (24, 24)   120x32   directly in the root viewport
##   NestedButton      (320, 70)   80x24   (20, 30) inside Embed, a 1:1 SubViewportContainer at (300, 40)
##   ShrunkButton      (60, 220)   80x32   (10, 10) 40x16 inside ShrunkEmbed at (40, 200), stretch_shrink 2
##   Rotated           (480, 250)  20x40   a 40x20 Control at (500, 250) rotated 90 degrees
##   WindowButton      (530, 70)   60x24   (10, 10) inside EmbeddedWindow, a borderless Window at (520, 60)
##   OffscreenButton   none                inside a SubViewport that nothing displays
## state() reports the clicks and every mouse event's position and button_mask.

var root_clicks := 0
var nested_clicks := 0
var shrunk_clicks := 0
var window_clicks := 0
var offscreen_clicks := 0
var motions: Array = []  # [x, y, button_mask]
var buttons: Array = []  # [pressed (0 or 1), x, y, button_mask]


func _ready() -> void:
	_button(self, "RootButton", Vector2(24, 24), Vector2(120, 32)).pressed.connect(func() -> void: root_clicks += 1)

	var embed := _container("Embed", Vector2(300, 40), Vector2(200, 120), false, 1)
	_button(embed.get_child(0), "NestedButton", Vector2(20, 30), Vector2(80, 24)).pressed.connect(
		func() -> void: nested_clicks += 1)

	var shrunk := _container("ShrunkEmbed", Vector2(40, 200), Vector2(160, 80), true, 2)
	_button(shrunk.get_child(0), "ShrunkButton", Vector2(10, 10), Vector2(40, 16)).pressed.connect(
		func() -> void: shrunk_clicks += 1)

	var rotated := Control.new()
	rotated.name = "Rotated"
	rotated.position = Vector2(500, 250)
	rotated.size = Vector2(40, 20)
	rotated.rotation = PI / 2.0
	rotated.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(rotated)

	var window := Window.new()
	window.name = "EmbeddedWindow"
	window.borderless = true
	window.unresizable = true
	window.position = Vector2i(520, 60)
	window.size = Vector2i(100, 80)
	add_child(window)
	_button(window, "WindowButton", Vector2(10, 10), Vector2(60, 24)).pressed.connect(
		func() -> void: window_clicks += 1)

	var offscreen := SubViewport.new()
	offscreen.name = "Offscreen"
	offscreen.size = Vector2i(64, 64)
	add_child(offscreen)
	_button(offscreen, "OffscreenButton", Vector2(5, 5), Vector2(40, 20)).pressed.connect(
		func() -> void: offscreen_clicks += 1)


func _input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		motions.append([roundi(mm.position.x), roundi(mm.position.y), mm.button_mask])
	elif event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		buttons.append([1 if mb.pressed else 0, roundi(mb.position.x), roundi(mb.position.y), mb.button_mask])


func reset() -> void:
	root_clicks = 0
	nested_clicks = 0
	shrunk_clicks = 0
	window_clicks = 0
	offscreen_clicks = 0
	motions.clear()
	buttons.clear()


func state() -> Dictionary:
	return {
		"root_clicks": root_clicks,
		"nested_clicks": nested_clicks,
		"shrunk_clicks": shrunk_clicks,
		"window_clicks": window_clicks,
		"offscreen_clicks": offscreen_clicks,
		"motions": motions,
		"buttons": buttons,
	}


func _button(parent: Node, node_name: String, at: Vector2, box: Vector2) -> Button:
	var b := Button.new()
	b.name = node_name
	b.position = at
	b.size = box
	parent.add_child(b)
	return b


func _container(node_name: String, at: Vector2, box: Vector2, stretch: bool, shrink: int) -> SubViewportContainer:
	var c := SubViewportContainer.new()
	c.name = node_name
	c.position = at
	c.stretch = stretch
	c.stretch_shrink = shrink
	c.size = box
	add_child(c)
	var vp := SubViewport.new()
	vp.name = node_name + "Viewport"
	vp.size = Vector2i(box) / shrink
	c.add_child(vp)
	return c
