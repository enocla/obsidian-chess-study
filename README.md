# Chess Study

An Obsidian plugin for studying chess in your notes. Put a game or a position in a `chess` (or `pgn`) code block and it becomes an interactive board with an evaluation bar. Moves you play on the board are written back into the note as PGN.

````markdown
```chess
[White "Kasparov"]
[Black "Topalov"]

1. e4 d6 2. d4 Nf6 3. Nc3 g6 (3... e5 4. Nf3) 4. Be3 $1 { A flexible setup. [%cal Gf1e2] } Bg7
```
````

A bare FEN works too, and an empty block starts from the initial position.

## Features

- **Edit by playing.** Click or drag pieces. A new move continues the line, or becomes a variation if the line already has a different move there. Promotions open a piece picker.
- **Variations, comments and annotations.** The move list shows variations and comments. Use the toolbar or right-click a move for `!! ! !? ?! ? ??`, *Promote variation* and *Delete from here*. Annotated moves get a coloured badge and highlight, using Brilliant Chess's colours.
- **Arrows and circles.** Right-drag to draw (Shift = red, Alt = blue, Shift+Alt = yellow). Knight moves are drawn as L-shaped arrows. They are saved in the move's comment as `[%cal …]` / `[%csl …]`, the same format Lichess and ChessBase use.
- **Evaluation bar.** Stockfish 19 (lite WebAssembly build) runs on your device, so nothing is sent anywhere. The bar, best-move arrow and principal variation update as the search deepens.
- **Cached evaluations.** Results are stored per position in the plugin folder (`eval-cache.json`), so positions you have already seen show instantly. Transpositions share an entry. Size and depth are set in settings.
- **Looks like Brilliant Chess, fits your theme.** The board uses Brilliant Chess's colours and themes (brown by default), chess.com's Neo pieces, legal-move dots and eval bar. The move list, engine line and controls sit beside the board, and stack under it in narrow panes. The controls and move list use Obsidian's theme variables, so they follow your light/dark theme and accent colour.

Keyboard (click the board first): `←` `→` step through moves, `↑`/`Home` jump to the start, `↓`/`End` jump to the end of the line, `F` flips the board. Add `[Orientation "black"]` to a block to show it from Black's side by default.

Boards in Live Preview, Reading view and callouts are all editable.

## Install with BRAT

1. Install **Obsidian42 - BRAT** from Community plugins and enable it.
2. Run *BRAT: Add a beta plugin for testing* and paste this repository's GitHub URL.
3. Enable **Chess Study** in Community plugins.

BRAT downloads `main.js`, `manifest.json` and `styles.css` from the latest GitHub release, so it works on desktop and mobile.

## Development

```sh
npm install
npm run dev     # watch build
npm run build   # type-check and production build
```

To try it in a vault, copy or symlink `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/chess-study/`.

### Releasing

```sh
npm version patch   # bumps package.json, manifest.json and versions.json, commits and tags
git push --follow-tags
```

The `Release` workflow builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release named after the tag. BRAT picks it up from there.

## Credits and licence

- Board styling and colours from [Brilliant Chess](https://github.com/wdeloo/Brilliant-Chess) (MIT).
- [chessground](https://github.com/lichess-org/chessground) (with a small build-time patch for L-shaped knight arrows, see `build/knight-arrows.mjs`) and [chessops](https://github.com/niklasf/chessops) by Lichess contributors (GPL-3.0).
- Pieces: Neo by Chess.com. They are not included in this repository or its releases. On first use they are downloaded from the same pinned source Brilliant Chess uses ([GiorgioMegrelli/chess.com-boards-and-pieces](https://github.com/GiorgioMegrelli/chess.com-boards-and-pieces)) and saved to `pieces-neo.json` in the plugin folder. Fallback pieces: Cburnett, CC BY-SA 3.0, via chessground.
- [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1 (GPL-3.0), embedded unmodified. See `vendor/stockfish/`.

Because it bundles GPL-3.0 code, this plugin is licensed under GPL-3.0-or-later.
