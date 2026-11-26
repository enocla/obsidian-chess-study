import { Editor, Plugin } from "obsidian";
import { ChessBoardView, type ViewState } from "./board-view";
import { Engine } from "./engine";
import { EvalCache } from "./eval-cache";
import { PieceSets } from "./pieces";
import { ChessStudySettingTab, type ChessStudySettings, DEFAULT_SETTINGS } from "./settings";

export const CODE_BLOCK_LANGUAGES = ["chess", "pgn"];

export default class ChessStudyPlugin extends Plugin {
	settings!: ChessStudySettings;
	engine = new Engine();
	cache!: EvalCache;
	pieces = new PieceSets(this);
	readonly views = new Set<ChessBoardView>();
	/** Board state (current move, orientation) that survives re-renders. */
	readonly viewStates = new Map<string, ViewState>();

	async onload() {
		await this.loadSettings();
		this.cache = new EvalCache(this, () => this.settings.cacheLimit);
		// Load the cache in the background so startup isn't delayed.
		this.app.workspace.onLayoutReady(() => {
			void this.cache.load();
			if (this.settings.pieceSet === "neo") void this.pieces.loadNeo();
		});

		for (const language of CODE_BLOCK_LANGUAGES) {
			try {
				this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
					ctx.addChild(new ChessBoardView(this, el, source, ctx));
				});
			} catch (error) {
				// Another chess plugin may already own this language; keep the others working.
				console.warn(`Chess Study: \`${language}\` code blocks are handled by another plugin`, error);
			}
		}

		this.addCommand({
			id: "insert-board",
			name: "Insert chess board",
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const prefix = cursor.ch === 0 ? "" : "\n";
				editor.replaceRange(`${prefix}\`\`\`chess\n\n\`\`\`\n`, cursor);
				editor.setCursor({ line: cursor.line + (prefix ? 2 : 1), ch: 0 });
			},
		});

		this.addSettingTab(new ChessStudySettingTab(this.app, this));
	}

	async onunload() {
		this.engine.dispose();
		this.pieces.unload();
		await this.cache?.flush();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.settings.pieceSet === "neo") void this.pieces.loadNeo();
		for (const view of this.views) view.applySettings();
	}
}
