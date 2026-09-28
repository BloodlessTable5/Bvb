# HOLDER.io

A playable, dark bubble-map survival game. This version is a local simulation with 24 AI opponents and fictional wallets; it has no cryptocurrency transactions or live multiplayer server.

## Play

Choose an alias and one of six translucent bubble colors, then enter the arena. Move your mouse, use WASD or arrow keys, or drag on a touch screen. Pressing movement keys switches to keyboard control and ignores mouse movement until you click the arena. Releasing the keys stops movement. Holding the mouse at any screen edge keeps moving in that direction. Space splits, C consolidates after the 5-second cooldown, E sheds mass for a forward boost, and Escape pauses. Bubbles also merge naturally when you overlap them after the cooldown. On-screen split and consolidate buttons support touch play. The six-second spawn shield only protects you from being eaten; you can absorb smaller holders immediately.

AI opponents hold their targets and use split attacks to catch smaller holders. They follow the same absorption and supply accounting rules as the player.

The arena has a plain dark background with subtle connecting lines between nearby bubbles of the same color. Small color-matched arrows at the screen edges point toward off-screen holders.

Absorb dots and smaller holders. A holder's share is the sum of all their bubbles divided by a fixed 50,000-token supply. Absorption transfers mass exactly; splitting and merging preserve it. Larger holders can eat you. The arena is an open space bounded at 3,200 × 2,400 world units, with no interior obstacles.

## Source

- `dist/index.html`: join screen, leaderboard, controls, dialogs.
- `dist/style.css`: responsive dark interface.
- `dist/engine.mjs`: simulation, collisions, supply accounting, split and merge rules.
- `dist/game.js`: rendering, input, camera, HUD, minimap, browser agent tools.
- `dist/navigation.mjs`: keyboard/mouse controls, continuous edge steering, and off-screen indicators.
- `dist/pathfinding.mjs`: obstacle-aware routing for AI and consolidation.

Serve the `dist` directory over HTTP with a static web server. No build or runtime dependencies are required. Google Fonts are optional; system font fallbacks are included. Only alias and color preferences are stored locally.
