# HOLDER.io

A playable, dark bubble-map survival game. This version is a local simulation with 24 AI opponents and fictional wallets; it has no cryptocurrency transactions or live multiplayer server.

## Play

Choose an alias and one of six translucent bubble colors, then enter the arena. Move your mouse, use arrow keys, or drag on a touch screen. Holding the mouse at any screen edge keeps moving in that direction. Space splits, W ejects supply, and Escape pauses. Bubbles merge naturally when you overlap them after the 10-second split cooldown; there is no manual consolidation key or button. An on-screen split button supports touch play.

The arena has a plain dark background, with small color-matched arrows at the screen edges pointing toward off-screen holders.

Absorb dots and smaller holders. A holder's share is the sum of all their bubbles divided by a fixed 50,000-token supply. Absorption transfers mass exactly; splitting and merging preserve it. Larger holders can eat you. The arena is bounded at 3,200 × 2,400 world units, with two solid squares and two solid triangles.

## Source

- `dist/index.html`: join screen, leaderboard, controls, dialogs.
- `dist/style.css`: responsive dark interface.
- `dist/engine.mjs`: simulation, collisions, supply accounting, split and merge rules.
- `dist/game.js`: rendering, input, camera, HUD, minimap, browser agent tools.
- `dist/navigation.mjs`: continuous edge steering and off-screen indicator placement.

Serve the `dist` directory over HTTP with a static web server. No build or runtime dependencies are required. Google Fonts are optional; system font fallbacks are included. Only alias and color preferences are stored locally.
