-- Hides the editor-only layers baked into the Luneblade sources before the sheet
-- export: the grey backdrop (named bg / BG / Background across the pack), plus the
-- label and mirror-reflection overlays. Hiding them (vs the CLI's --ignore-layer,
-- which silently no-ops on some of these files) reliably yields transparent frames.
-- Runs against the sprite opened by `aseprite -b <file> --script this.lua --sheet ...`.
local s = app.activeSprite
if not s then return end
local drop = { bg = true, background = true, text = true, reflection = true, layer1 = true }
local function walk(layers)
  for _, l in ipairs(layers) do
    local n = l.name:lower():gsub("%s", "")
    if drop[n] then l.isVisible = false end
    if l.isGroup then walk(l.layers) end
  end
end
walk(s.layers)
