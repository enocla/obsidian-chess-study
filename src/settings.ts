import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ChessStudyPlugin from "./main";

export interface BoardTheme {
	name: string;
	light: string;
	dark: string;
	highlight: string;
}

/** Board colours from Brilliant Chess. */
export const BOARD_THEMES: Record<string, BoardTheme> = {
	green: { name: "Green", dark: "#779556", light: "#ebecd0", highlight: "#ffff33" },
	brown: { name: "Brown", dark: "#b58863", light: "#f0d9b5", highlight: "#ffff33" },
	blue: { name: "Blue", dark: "#4d6d92", light: "#ececd7", highlight: "#00a5ff" },
	gray: { name: "Gray", dark: "#4f4f4f", light: "#e3e3e3", highlight: "#ffff33" },
	red: { name: "Red", dark: "#ba5546", light: "#f0d8bf", highlight: "#f8f893" },
	purple: { name: "Purple", dark: "#8877b7", light: "#efefef", highlight: "#7dacc9" },
	orange: { name: "Orange", dark: "#d08b18", light: "#fce4b2", highlight: "#ffff33" },
};

export interface ChessStudySettings {
	boardTheme: string;
	pieceSet: "neo" | "cburnett";
	maxBoardWidth: number;
	startAt: "start" | "end";
	showLegalMoves: boolean;
	animation: boolean;
	engineEnabled: boolean;
	depth: number;
	showBestMove: boolean;
	showEngineLine: boolean;
	cacheLimit: number;
}

export const DEFAULT_SETTINGS: ChessStudySettings = {
	boardTheme: "brown",
	pieceSet: "neo",
	maxBoardWidth: 400,
	startAt: "start",
	showLegalMoves: true,
	animation: true,
	engineEnabled: true,
	depth: 16,
	showBestMove: true,
	showEngineLine: true,
	cacheLimit: 20000,
};

export class ChessStudySettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ChessStudyPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl, plugin } = this;
		const settings = plugin.settings;
		containerEl.empty();

		new Setting(containerEl).setName("Board").setHeading();

		new Setting(containerEl).setName("Board theme").addDropdown(dropdown => {
			for (const [key, theme] of Object.entries(BOARD_THEMES)) dropdown.addOption(key, theme.name);
			dropdown.setValue(settings.boardTheme).onChange(async value => {
				settings.boardTheme = value;
				await plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("Pieces")
			.setDesc("Neo is chess.com's set (as in Brilliant Chess). It is downloaded once and kept in the plugin folder; Cburnett is built in and used until then.")
			.addDropdown(dropdown =>
				dropdown
					.addOption("neo", "Neo")
					.addOption("cburnett", "Cburnett")
					.setValue(settings.pieceSet)
					.onChange(async value => {
						settings.pieceSet = value as ChessStudySettings["pieceSet"];
						await plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum board width")
			.setDesc("In pixels. Boards shrink to fit narrow notes, and the move list sits beside the board when there is room.")
			.addSlider(slider =>
				slider
					.setLimits(240, 900, 20)
					.setValue(settings.maxBoardWidth)
					.setDynamicTooltip()
					.onChange(async value => {
						settings.maxBoardWidth = value;
						await plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Open boards at")
			.setDesc("Which position a board shows when a note opens.")
			.addDropdown(dropdown =>
				dropdown
					.addOption("start", "Starting position")
					.addOption("end", "End of the main line")
					.setValue(settings.startAt)
					.onChange(async value => {
						settings.startAt = value as ChessStudySettings["startAt"];
						await plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Show legal moves").addToggle(toggle =>
			toggle.setValue(settings.showLegalMoves).onChange(async value => {
				settings.showLegalMoves = value;
				await plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Animate moves").addToggle(toggle =>
			toggle.setValue(settings.animation).onChange(async value => {
				settings.animation = value;
				await plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Engine").setHeading();

		new Setting(containerEl)
			.setName("Evaluate positions")
			.setDesc("Run Stockfish 19 (lite, WebAssembly) on your device and show an evaluation bar.")
			.addToggle(toggle =>
				toggle.setValue(settings.engineEnabled).onChange(async value => {
					settings.engineEnabled = value;
					await plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Search depth")
			.setDesc("Higher is stronger and slower. Cached results at this depth or deeper are reused.")
			.addSlider(slider =>
				slider
					.setLimits(8, 28, 1)
					.setValue(settings.depth)
					.setDynamicTooltip()
					.onChange(async value => {
						settings.depth = value;
						await plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Show best move arrow").addToggle(toggle =>
			toggle.setValue(settings.showBestMove).onChange(async value => {
				settings.showBestMove = value;
				await plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Show engine line").addToggle(toggle =>
			toggle.setValue(settings.showEngineLine).onChange(async value => {
				settings.showEngineLine = value;
				await plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Cached positions")
			.setDesc(`Keep up to this many evaluations. ${plugin.cache.size.toLocaleString()} cached now.`)
			.addText(text =>
				text
					.setValue(String(settings.cacheLimit))
					.onChange(async value => {
						const limit = Number(value);
						if (!Number.isFinite(limit) || limit < 0) return;
						settings.cacheLimit = Math.round(limit);
						await plugin.saveSettings();
					}),
			)
			.addButton(button =>
				button.setButtonText("Clear cache").onClick(async () => {
					await plugin.cache.clear();
					new Notice("Chess Study: evaluation cache cleared");
					this.display();
				}),
			);
	}
}
