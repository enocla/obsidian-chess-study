import { arrayBufferToBase64, type Plugin, requestUrl } from "obsidian";

/**
 * Chess.com's Neo pieces, as used by Brilliant Chess. They aren't bundled with the plugin:
 * they are downloaded once from the same pinned source Brilliant Chess uses, saved in the
 * plugin folder for offline use, and the bundled Cburnett pieces are used until then.
 */
const NEO_SOURCE = "https://raw.githubusercontent.com/GiorgioMegrelli/chess.com-boards-and-pieces/51131f1e8eb89d62f7d23ecc023f39a36e39dd24/pieces/ejgfv";
const ROLES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const COLORS: Record<string, string> = { w: "white", b: "black" };

type PieceImages = Record<string, string>;

export class PieceSets {
	private style?: HTMLStyleElement;
	private loading?: Promise<void>;
	private readonly path: string;

	constructor(private plugin: Plugin) {
		this.path = `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/pieces-neo.json`;
	}

	/** Make the Neo pieces available. Boards opt in with the `cs-pieces-neo` class. */
	loadNeo(): Promise<void> {
		this.loading ??= this.load().catch(error => {
			this.loading = undefined;
			console.warn("Chess Study: could not load Neo pieces, using Cburnett", error);
		});
		return this.loading;
	}

	unload() {
		this.style?.remove();
		this.style = undefined;
	}

	private async load() {
		const images = (await this.read()) ?? (await this.download());
		const rules = Object.entries(images).map(([code, data]) => {
			const color = COLORS[code[0]];
			const role = ROLES[code[1]];
			return `.chess-study.cs-pieces-neo .cg-wrap piece.${role}.${color} { background-image: url("data:image/png;base64,${data}"); }`;
		});
		this.unload();
		this.style = document.head.createEl("style", { attr: { id: "chess-study-neo-pieces" } });
		this.style.textContent = rules.join("\n");
	}

	private async read(): Promise<PieceImages | undefined> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.path))) return;
		const images = JSON.parse(await adapter.read(this.path)) as PieceImages;
		return Object.keys(images).length === 12 ? images : undefined;
	}

	private async download(): Promise<PieceImages> {
		const images: PieceImages = {};
		await Promise.all(
			Object.keys(COLORS).flatMap(color =>
				Object.keys(ROLES).map(async role => {
					const response = await requestUrl({ url: `${NEO_SOURCE}/${color}${role}.png` });
					images[color + role] = arrayBufferToBase64(response.arrayBuffer);
				}),
			),
		);
		await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(images));
		return images;
	}
}
