import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { DrawBrushes, DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { normalizeMove } from "chessops/chess";
import { chessgroundDests } from "chessops/compat";
import type { ChildNode, CommentShape, CommentShapeColor, Node, PgnNodeData } from "chessops/pgn";
import { makeSanAndPlay } from "chessops/san";
import type { Color, Move, Role } from "chessops/types";
import { makeSquare, parseSquare, parseUci, squareRank } from "chessops/util";
import {
	type MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	Notice,
	setIcon,
	setTooltip,
	TFile,
} from "obsidian";
import type { Evaluation } from "./engine";
import type ChessStudyPlugin from "./main";
import { CODE_BLOCK_LANGUAGES } from "./main";
import { BOARD_THEMES } from "./settings";
import { MOVE_NAGS, type Path, type Step, Study } from "./study";

export interface ViewState {
	path: Path;
	orientation: Color;
	engineOn: boolean;
}

/** Highlight colours from Brilliant Chess, by annotation. */
const NAG_STYLE: Record<number, { color: string; label: string }> = {
	3: { color: "#26c2a3", label: "Brilliant" },
	1: { color: "#749bbf", label: "Good move" },
	5: { color: "#95b776", label: "Interesting" },
	6: { color: "#f7c631", label: "Dubious" },
	2: { color: "#ffa459", label: "Mistake" },
	4: { color: "#fa412d", label: "Blunder" },
};
const NAG_ORDER = [3, 1, 5, 6, 2, 4];

/**
 * Chessground names arrowhead markers after the brush key. Obsidian keeps hidden copies of
 * rendered notes in the DOM, so keys must be unique per board or arrows lose their heads.
 */
function brushes(id: string): DrawBrushes {
	return {
		green: { key: `${id}g`, color: "#81b64c", opacity: 0.85, lineWidth: 10 },
		red: { key: `${id}r`, color: "#eb6150", opacity: 0.85, lineWidth: 10 },
		blue: { key: `${id}b`, color: "#749bbf", opacity: 0.85, lineWidth: 10 },
		yellow: { key: `${id}y`, color: "#ffaa00", opacity: 0.85, lineWidth: 10 },
		engine: { key: `${id}e`, color: "#9fcf3f", opacity: 0.45, lineWidth: 7 },
	};
}
const SHAPE_COLORS: CommentShapeColor[] = ["green", "red", "blue", "yellow"];

let nextId = 0;

export class ChessBoardView extends MarkdownRenderChild {
	private readonly id = `chess-study-${nextId++}`;
	private study!: Study;
	private path: Path = [];
	private steps: Step[] = [];
	private orientation: Color = "white";
	private engineOn = true;
	private readOnly = false;
	private visible = false;
	private evaluation?: { fen: string; ev: Evaluation };
	private saving: Promise<void> = Promise.resolve();
	private observer?: IntersectionObserver;
	private resizeObserver?: ResizeObserver;
	private cg?: Api;

	private root!: HTMLElement;
	private boardWrap!: HTMLElement;
	private evalBar!: HTMLElement;
	private evalFill!: HTMLElement;
	private evalLabel!: HTMLElement;
	private engineLine!: HTMLElement;
	private movesEl!: HTMLElement;
	private commentBox!: HTMLTextAreaElement;
	private buttons: Record<string, HTMLButtonElement> = {};
	private nagButtons = new Map<number, HTMLButtonElement>();
	private closePromotion?: () => void;

	constructor(
		private plugin: ChessStudyPlugin,
		containerEl: HTMLElement,
		private source: string,
		private ctx: MarkdownPostProcessorContext,
	) {
		super(containerEl);
	}

	onload() {
		this.study = Study.parse(this.source);
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		this.readOnly = !!this.study.error || !(file instanceof TFile) || file.extension !== "md";

		const saved = this.plugin.viewStates.get(this.stateKey());
		const headerOrientation = this.study.game.headers.get("Orientation")?.toLowerCase();
		this.orientation = saved?.orientation ?? (headerOrientation === "black" ? "black" : "white");
		this.engineOn = saved?.engineOn ?? true;
		const initial = saved?.path ?? (this.plugin.settings.startAt === "end" ? this.study.mainlinePath() : []);
		this.path = this.study.validPath(initial);

		this.build();
		this.plugin.views.add(this);
		this.update(false);

		this.observer = new IntersectionObserver(entries => {
			const visible = entries.some(entry => entry.isIntersecting);
			if (visible === this.visible) return;
			this.visible = visible;
			if (visible) {
				// The board may have been laid out while hidden. Refresh its cached position and
				// redraw arrows, which are skipped until the board has a size.
				this.cg?.state.dom.bounds.clear();
				this.update(false);
			}
			else this.plugin.engine.cancel(this.id);
		});
		this.observer.observe(this.root);

		// Chessground sizes its board in its own ResizeObserver, which runs before this one.
		// Arrows are skipped until the board has a size, so draw them once it does.
		this.resizeObserver = new ResizeObserver(() => {
			if (!this.cg || !this.hasLayout()) return;
			this.cg.state.dom.bounds.clear();
			this.cg.setShapes(this.commentShapes());
			this.cg.setAutoShapes(this.autoShapes());
		});
		this.resizeObserver.observe(this.cg!.state.dom.elements.wrap);
	}

	onunload() {
		this.closePromotion?.();
		this.observer?.disconnect();
		this.resizeObserver?.disconnect();
		this.plugin.engine.cancel(this.id);
		this.plugin.views.delete(this);
		this.cg?.destroy();
	}

	applySettings() {
		this.applySettingsToRoot();
		this.cg?.set({ animation: { enabled: this.plugin.settings.animation }, movable: { showDests: this.plugin.settings.showLegalMoves } });
		this.update(false);
	}

	// ---------------------------------------------------------------- layout

	private build() {
		const root = (this.root = this.containerEl.createDiv({ cls: "chess-study" }));
		root.tabIndex = 0;
		root.addEventListener("keydown", e => this.onKey(e));
		// Keep Live Preview (and callouts) from switching to source mode when the board is used.
		for (const type of ["mousedown", "touchstart", "pointerdown", "click"]) {
			root.addEventListener(type, e => e.stopPropagation());
		}
		// Chessground caches the board's screen position and only refreshes it on scroll or
		// resize. Notes can reflow without either, so refresh before every interaction.
		for (const type of ["mousedown", "touchstart"]) {
			root.addEventListener(
				type,
				e => {
					if (e.target instanceof Element && e.target.closest("cg-board")) this.cg?.state.dom.bounds.clear();
					// Chessground prevents default on the board, which would stop it taking focus.
					if (!(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) root.focus({ preventScroll: true });
				},
				{ capture: true },
			);
		}

		this.buildHeader(root);

		// Board on the left; engine line, moves, comment box and controls beside it.
		const layout = root.createDiv({ cls: "cs-layout" });
		const main = layout.createDiv({ cls: "cs-main" });
		this.evalBar = main.createDiv({ cls: "cs-eval" });
		this.evalFill = this.evalBar.createDiv({ cls: "cs-eval-fill" });
		this.evalLabel = this.evalBar.createDiv({ cls: "cs-eval-label" });
		this.boardWrap = main.createDiv({ cls: "cs-board-wrap" });
		const boardEl = this.boardWrap.createDiv({ cls: "cs-board" });

		const panel = layout.createDiv({ cls: "cs-side" }).createDiv({ cls: "cs-side-inner" });
		this.engineLine = panel.createDiv({ cls: "cs-engine-line" });
		this.movesEl = panel.createDiv({ cls: "cs-moves" });
		this.commentBox = panel.createEl("textarea", { cls: "cs-comment-box", attr: { rows: "2", placeholder: "Comment on this move (Enter to save, Shift+Enter for a new line)" } });
		const controls = panel.createDiv({ cls: "cs-controls" });
		const nav = controls.createDiv({ cls: "cs-group" });
		this.addButton(nav, "first", "chevrons-left", "First move (↑)", () => this.goTo([]));
		this.addButton(nav, "prev", "chevron-left", "Previous move (←)", () => this.goTo(this.path.slice(0, -1)));
		this.addButton(nav, "next", "chevron-right", "Next move (→)", () => this.next());
		this.addButton(nav, "last", "chevrons-right", "Last move (↓)", () => this.goTo(this.study.mainlinePath(this.path)));

		const tools = controls.createDiv({ cls: "cs-group" });
		this.addButton(tools, "flip", "arrow-up-down", "Flip board (F)", () => this.flip());
		this.addButton(tools, "engine", "cpu", "Toggle engine", () => this.toggleEngine());
		this.addButton(tools, "comment", "message-square", "Comment on this move", () => this.toggleCommentBox());
		this.addButton(tools, "more", "more-horizontal", "More", e => this.showMenu(e, this.path));

		const annotate = controls.createDiv({ cls: "cs-group cs-annotate" });
		for (const nag of NAG_ORDER) {
			const button = annotate.createEl("button", { cls: "cs-nag-button", text: MOVE_NAGS[nag] });
			button.style.setProperty("--cs-nag", NAG_STYLE[nag].color);
			setTooltip(button, NAG_STYLE[nag].label);
			button.addEventListener("click", () => this.toggleNag(nag));
			this.nagButtons.set(nag, button);
		}

		this.commentBox.hide();
		this.commentBox.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Escape") {
				this.commentBox.value = this.study.comment(this.path).text;
				this.root.focus();
			} else if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.commentBox.blur();
			}
		});
		this.commentBox.addEventListener("blur", () => {
			this.saveComment();
			this.commentBox.hide();
		});

		if (this.study.error) root.createDiv({ cls: "cs-error", text: `${this.study.error}. The board is read-only until the PGN is fixed.` });

		this.cg = Chessground(boardEl, {
			orientation: this.orientation,
			coordinates: true,
			disableContextMenu: true,
			highlight: { lastMove: true, check: true },
			animation: { enabled: this.plugin.settings.animation, duration: 150 },
			movable: {
				free: false,
				rookCastle: false,
				showDests: this.plugin.settings.showLegalMoves,
				events: { after: (orig, dest) => this.onBoardMove(orig, dest) },
			},
			premovable: { enabled: false },
			draggable: { enabled: true, showGhost: true },
			drawable: {
				enabled: true,
				eraseOnClick: false,
				defaultSnapToValidMove: true,
				brushes: brushes(this.id),
				onChange: shapes => this.onShapes(shapes),
			},
		});

		this.applySettingsToRoot();
	}

	private applySettingsToRoot() {
		const settings = this.plugin.settings;
		const theme = BOARD_THEMES[settings.boardTheme] ?? BOARD_THEMES.brown;
		this.root.style.setProperty("--cs-light", theme.light);
		this.root.style.setProperty("--cs-dark", theme.dark);
		this.root.style.setProperty("--cs-highlight", theme.highlight);
		this.root.style.setProperty("--cs-max-width", `${settings.maxBoardWidth}px`);
		this.root.toggleClass("cs-hide-dests", !settings.showLegalMoves);
		this.root.toggleClass("cs-pieces-neo", settings.pieceSet === "neo");
	}

	private buildHeader(root: HTMLElement) {
		const headers = this.study.game.headers;
		const white = headers.get("White");
		const black = headers.get("Black");
		if (!white && !black && !headers.get("Event")) return;
		const header = root.createDiv({ cls: "cs-header" });
		const players = header.createDiv({ cls: "cs-players" });
		const player = (name: string | undefined, elo: string | undefined, color: Color) => {
			const el = players.createSpan({ cls: `cs-player cs-player-${color}` });
			el.createSpan({ cls: "cs-player-dot" });
			el.createSpan({ text: name && name !== "?" ? name : color === "white" ? "White" : "Black" });
			if (elo && elo !== "?") el.createSpan({ cls: "cs-elo", text: ` (${elo})` });
		};
		player(white, headers.get("WhiteElo"), "white");
		players.createSpan({ cls: "cs-vs", text: "vs" });
		player(black, headers.get("BlackElo"), "black");
		const meta = [headers.get("Event"), headers.get("Date")?.replace(/\.\?\?/g, ""), headers.get("Result")]
			.filter(value => value && value !== "?" && value !== "*" && value !== "????")
			.join(" · ");
		if (meta) header.createDiv({ cls: "cs-meta", text: meta });
	}

	private addButton(parent: HTMLElement, key: string, icon: string, label: string, onClick: (e: MouseEvent) => void) {
		const button = parent.createEl("button", { cls: "clickable-icon cs-button", attr: { "aria-label": label } });
		setIcon(button, icon);
		setTooltip(button, label);
		button.addEventListener("click", onClick);
		this.buttons[key] = button;
	}

	// ---------------------------------------------------------------- state

	/** Arrows drawn before the board has a size come out as NaN, so wait for layout. */
	private hasLayout() {
		const board = this.cg?.state.dom.elements.board;
		return !!board && board.isConnected && board.getBoundingClientRect().width > 0;
	}

	private get current(): Step {
		return this.steps[this.steps.length - 1];
	}

	private stateKey(source = this.source) {
		return `${this.ctx.sourcePath}\n${source.trim()}`;
	}

	private rememberState(source = this.source) {
		this.plugin.viewStates.set(this.stateKey(source), { path: this.path, orientation: this.orientation, engineOn: this.engineOn });
	}

	private update(animate = true) {
		this.steps = this.study.steps(this.path);
		this.path = this.path.slice(0, this.steps.length - 1);
		const { pos, fen, uci } = this.current;
		const lastMove = uci ? ([uci.slice(0, 2), uci.slice(2, 4)] as Key[]) : undefined;
		const turn = pos.turn;

		this.cg?.set({
			animation: { enabled: animate && this.plugin.settings.animation },
			orientation: this.orientation,
			fen,
			turnColor: turn,
			check: pos.isCheck() ? turn : false,
			lastMove,
			movable: { color: pos.isEnd() ? undefined : turn, dests: chessgroundDests(pos) },
			drawable: { shapes: this.hasLayout() ? this.commentShapes() : [] },
		});
		if (!animate) this.cg?.set({ animation: { enabled: this.plugin.settings.animation } });

		const nag = this.study.moveNag(this.current.node);
		this.root.style.setProperty("--cs-last-move", nag ? NAG_STYLE[nag].color : "var(--cs-highlight)");

		const atRoot = this.path.length === 0;
		const hasNext = this.current.node.children.length > 0;
		this.buttons.first.disabled = atRoot;
		this.buttons.prev.disabled = atRoot;
		this.buttons.next.disabled = !hasNext;
		this.buttons.last.disabled = !hasNext;
		this.buttons.engine.toggleClass("is-active", this.engineOn);
		this.buttons.comment.disabled = this.readOnly;
		for (const [n, button] of this.nagButtons) {
			button.disabled = atRoot || this.readOnly;
			button.toggleClass("is-active", n === nag);
		}
		if (this.commentBox.isShown()) this.commentBox.value = this.study.comment(this.path).text;

		this.evalBar.toggle(this.engineOn && this.plugin.settings.engineEnabled);
		this.evalBar.toggleClass("is-flipped", this.orientation === "black");
		this.renderMoves();
		this.rememberState();
		this.requestEval();
	}

	private goTo(path: Path) {
		this.closePromotion?.();
		this.path = this.study.validPath(path);
		this.update();
	}

	private next() {
		if (this.current.node.children.length) this.goTo([...this.path, 0]);
	}

	private flip() {
		this.orientation = this.orientation === "white" ? "black" : "white";
		this.update(false);
	}

	private toggleEngine() {
		this.engineOn = !this.engineOn;
		if (!this.engineOn) this.plugin.engine.cancel(this.id);
		this.update(false);
	}

	private onKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
		const actions: Record<string, () => void> = {
			ArrowLeft: () => this.goTo(this.path.slice(0, -1)),
			ArrowRight: () => this.next(),
			ArrowUp: () => this.goTo([]),
			Home: () => this.goTo([]),
			ArrowDown: () => this.goTo(this.study.mainlinePath(this.path)),
			End: () => this.goTo(this.study.mainlinePath(this.path)),
			f: () => this.flip(),
		};
		const action = actions[e.key];
		if (!action || e.metaKey || e.ctrlKey || e.altKey) return;
		e.preventDefault();
		e.stopPropagation();
		action();
	}

	// ---------------------------------------------------------------- moves

	private onBoardMove(orig: Key, dest: Key) {
		const from = parseSquare(orig);
		const to = parseSquare(dest);
		if (from === undefined || to === undefined) return;
		const pos = this.current.pos;
		const piece = pos.board.get(from);
		const rank = squareRank(to);
		if (piece?.role === "pawn" && (rank === 0 || rank === 7)) {
			void this.choosePromotion(dest, pos.turn).then(role => {
				if (role) this.playMove({ from, to, promotion: role });
				else this.update(false);
			});
			return;
		}
		this.playMove({ from, to });
	}

	private playMove(move: Move) {
		const pos = this.current.pos;
		const normalized = normalizeMove(pos, move);
		if (!pos.isLegal(normalized)) {
			this.update(false);
			return;
		}
		const parent = this.current.node;
		const before = parent.children.length;
		this.path = this.study.play(this.path, normalized);
		// The board already shows the move, so skip the animation.
		this.update(false);
		if (parent.children.length !== before) this.save();
	}

	private choosePromotion(dest: Key, color: Color): Promise<Role | undefined> {
		this.closePromotion?.();
		return new Promise(resolve => {
			const file = dest.charCodeAt(0) - 97;
			const promotesUp = color === this.orientation;
			const backdrop = this.boardWrap.createDiv({ cls: "cs-promotion-backdrop" });
			const picker = this.boardWrap.createDiv({ cls: "cs-promotion cg-wrap" });
			picker.style.left = `${(this.orientation === "white" ? file : 7 - file) * 12.5}%`;
			picker.toggleClass("is-bottom", !promotesUp);
			const roles: Role[] = ["queen", "knight", "rook", "bishop"];
			const done = (role?: Role) => {
				backdrop.remove();
				picker.remove();
				this.closePromotion = undefined;
				resolve(role);
			};
			for (const role of roles) {
				const option = picker.createDiv({ cls: "cs-promotion-option" });
				option.createEl("piece" as keyof HTMLElementTagNameMap, { cls: `${role} ${color}` });
				option.addEventListener("click", () => done(role));
			}
			const cancel = picker.createDiv({ cls: "cs-promotion-cancel" });
			setIcon(cancel, "x");
			cancel.addEventListener("click", () => done());
			backdrop.addEventListener("click", () => done());
			this.closePromotion = () => done();
		});
	}

	private toggleNag(nag: number) {
		if (this.readOnly || !this.path.length) return;
		this.study.toggleNag(this.path, nag);
		this.update(false);
		this.save();
	}

	private deleteFrom(path: Path) {
		if (!path.length) return;
		const at = path.length - 1;
		this.path = remapPath(this.path, path.slice(0, at), index => (index === path[at] ? undefined : index > path[at] ? index - 1 : index));
		this.study.delete(path);
		this.update(false);
		this.save();
	}

	private promote(path: Path) {
		const promoted = this.study.promote(path);
		const at = promoted.findIndex((index, i) => index !== path[i]);
		if (at >= 0) {
			const moved = path[at];
			this.path = remapPath(this.path, path.slice(0, at), index => (index === moved ? 0 : index < moved ? index + 1 : index));
		}
		this.update(false);
		this.save();
	}

	private showMenu(e: MouseEvent, path: Path) {
		const menu = new Menu();
		const editable = !this.readOnly && path.length > 0;
		if (editable) {
			for (const nag of NAG_ORDER) {
				menu.addItem(item =>
					item.setTitle(`${MOVE_NAGS[nag]}  ${NAG_STYLE[nag].label}`).onClick(() => {
						this.path = path;
						this.toggleNag(nag);
					}),
				);
			}
			menu.addSeparator();
			menu.addItem(item =>
				item
					.setTitle("Promote variation")
					.setIcon("arrow-up")
					.setDisabled(!this.study.canPromote(path))
					.onClick(() => this.promote(path)),
			);
			menu.addItem(item =>
				item
					.setTitle("Delete from here")
					.setIcon("trash-2")
					.onClick(() => this.deleteFrom(path)),
			);
			menu.addSeparator();
		}
		if (!this.readOnly && this.commentShapes().length && path.join() === this.path.join()) {
			menu.addItem(item =>
				item
					.setTitle("Clear arrows")
					.setIcon("eraser")
					.onClick(() => this.onShapes([])),
			);
		}
		menu.addItem(item =>
			item
				.setTitle("Copy FEN")
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard.writeText(this.study.steps(path).pop()!.fen);
					new Notice("FEN copied");
				}),
		);
		menu.addItem(item =>
			item
				.setTitle("Copy PGN")
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard.writeText(this.study.serialize());
					new Notice("PGN copied");
				}),
		);
		menu.showAtMouseEvent(e);
	}

	// ---------------------------------------------------------------- comments and arrows

	private commentShapes(): DrawShape[] {
		return this.study.comment(this.path).shapes.map(shape => ({
			orig: makeSquare(shape.from) as Key,
			dest: shape.from === shape.to ? undefined : (makeSquare(shape.to) as Key),
			brush: shape.color,
		}));
	}

	private onShapes(shapes: DrawShape[]) {
		if (this.readOnly) return;
		const converted: CommentShape[] = [];
		for (const shape of shapes) {
			const from = parseSquare(shape.orig);
			const to = shape.dest ? parseSquare(shape.dest) : from;
			const color = SHAPE_COLORS.find(c => c === shape.brush) ?? "green";
			if (from !== undefined && to !== undefined) converted.push({ color, from, to });
		}
		this.study.setShapes(this.path, converted);
		if (!shapes.length) this.cg?.setShapes([]);
		this.renderMoves();
		this.save();
	}

	private toggleCommentBox() {
		if (this.commentBox.isShown()) {
			this.commentBox.blur();
			return;
		}
		this.commentBox.value = this.study.comment(this.path).text;
		this.commentBox.show();
		this.commentBox.focus();
	}

	private saveComment() {
		if (this.readOnly) return;
		const text = this.commentBox.value.trim();
		if (text === this.study.comment(this.path).text.trim()) return;
		this.study.updateComment(this.path, { text });
		this.renderMoves();
		this.save();
	}

	// ---------------------------------------------------------------- move list

	private renderMoves() {
		const el = this.movesEl;
		el.empty();
		const rootComment = this.study.comment([]).text;
		if (rootComment) el.createSpan({ cls: "cs-comment", text: rootComment });
		if (!this.study.game.moves.children.length) {
			el.createSpan({ cls: "cs-empty", text: this.readOnly ? "No moves." : "Make a move on the board to start." });
			return;
		}
		this.renderLine(el, this.study.game.moves, [], this.study.startPly, true, 0);
		const result = this.study.game.headers.get("Result");
		if (result && result !== "*") el.createSpan({ cls: "cs-result", text: result });
		el.querySelector(".cs-move.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	private renderLine(el: HTMLElement, start: Node<PgnNodeData>, startPath: Path, startPly: number, needNumber: boolean, depth: number) {
		let node = start;
		let path = startPath;
		let ply = startPly;
		while (node.children.length) {
			const [main, ...variations] = node.children;
			const mainPath = [...path, 0];
			needNumber = this.renderMove(el, main, mainPath, ply, needNumber);
			variations.forEach((child, i) => {
				const varPath = [...path, i + 1];
				const container = depth === 0 ? el.createDiv({ cls: "cs-variation" }) : el.createSpan({ cls: "cs-variation cs-inline" });
				if (depth > 0) container.createSpan({ cls: "cs-paren", text: "(" });
				const afterMove = this.renderMove(container, child, varPath, ply, true);
				this.renderLine(container, child, varPath, ply + 1, afterMove, depth + 1);
				if (depth > 0) container.createSpan({ cls: "cs-paren", text: ")" });
			});
			if (variations.length) needNumber = true;
			node = main;
			path = mainPath;
			ply++;
		}
	}

	/** Render one move. Returns whether the next move needs its own move number. */
	private renderMove(el: HTMLElement, node: ChildNode<PgnNodeData>, path: Path, plyBefore: number, needNumber: boolean): boolean {
		const white = plyBefore % 2 === 0;
		const number = Math.floor(plyBefore / 2) + 1;
		const key = path.join(".");
		const active = key === this.path.join(".");
		const move = el.createSpan({ cls: "cs-move", attr: { "data-path": key } });
		if (white || needNumber) move.createSpan({ cls: "cs-move-number", text: white ? `${number}.` : `${number}…` });
		move.createSpan({ cls: "cs-san", text: node.data.san });
		const nag = this.study.moveNag(node);
		if (nag) {
			const glyph = move.createSpan({ cls: "cs-glyph", text: MOVE_NAGS[nag] });
			glyph.style.color = NAG_STYLE[nag].color;
		}
		if (active) move.addClass("is-active");
		move.addEventListener("click", () => this.goTo(path));
		move.addEventListener("contextmenu", e => {
			e.preventDefault();
			this.showMenu(e, path);
		});
		const comment = this.study.comment(path).text;
		if (comment) {
			el.createSpan({ cls: "cs-comment", text: comment });
			return true;
		}
		return false;
	}

	// ---------------------------------------------------------------- engine

	private requestEval() {
		const enabled = this.engineOn && this.plugin.settings.engineEnabled;
		this.root.toggleClass("cs-engine-off", !enabled);
		if (!enabled) {
			this.engineLine.empty();
			this.cg?.setAutoShapes(this.autoShapes());
			return;
		}
		const { pos, fen } = this.current;

		if (pos.isEnd()) {
			this.plugin.engine.cancel(this.id);
			const winner = pos.outcome()?.winner;
			this.showEval(fen, winner ? { depth: 0, mate: 0, pv: [] } : { depth: 0, cp: 0, pv: [] });
			return;
		}

		const cached = this.plugin.cache.get(fen);
		this.showEval(fen, cached);
		if (!this.visible) return;
		const target = this.plugin.settings.depth;
		if (cached && cached.depth >= target) {
			this.plugin.engine.cancel(this.id);
			return;
		}
		void this.plugin.engine
			.analyze(this.id, fen, target, ev => {
				if (this.current.fen === fen && (!cached || ev.depth > cached.depth)) this.showEval(fen, ev);
			})
			.then(final => {
				if (!final) return;
				this.plugin.cache.set(fen, final);
				if (this.current.fen === fen && (!cached || final.depth >= cached.depth)) this.showEval(fen, final);
			});
	}

	private showEval(fen: string, ev: Evaluation | undefined) {
		this.evaluation = ev ? { fen, ev } : undefined;
		this.root.toggleClass("cs-eval-pending", !ev);
		this.cg?.setAutoShapes(this.autoShapes());
		if (!ev) {
			this.engineLine.setText(this.plugin.settings.showEngineLine ? "Evaluating…" : "");
			return;
		}
		const turn = this.current.pos.turn;
		const ended = this.current.pos.isEnd();
		let percent: number;
		let label: string;
		if (ev.mate !== undefined) {
			const whiteMates = ev.mate > 0 || (ev.mate === 0 && turn === "black");
			percent = whiteMates ? 100 : 0;
			label = ev.mate === 0 ? (whiteMates ? "1-0" : "0-1") : `M${Math.abs(ev.mate)}`;
		} else {
			const cp = ev.cp ?? 0;
			// Same mapping as Brilliant Chess: ±4 pawns fills 5–95% of the bar.
			percent = Math.min(95, Math.max(5, 50 + (cp / 400) * 45));
			label = ended ? "½-½" : (Math.abs(cp) / 100).toFixed(1);
		}
		this.evalFill.style.height = `${percent}%`;
		this.evalLabel.setText(label);
		this.evalBar.toggleClass("is-white-ahead", percent >= 50);
		setTooltip(this.evalBar, `${formatScore(ev)}${ev.depth ? ` · depth ${ev.depth}` : ""}`, { placement: "left" });

		this.engineLine.empty();
		if (!this.plugin.settings.showEngineLine || ended) return;
		this.engineLine.createSpan({ cls: "cs-score", text: formatScore(ev) });
		this.engineLine.createSpan({ cls: "cs-pv", text: this.formatPv(ev.pv) });
		this.engineLine.createSpan({ cls: "cs-depth", text: `d${ev.depth}` });
	}

	private formatPv(pv: string[]): string {
		const pos = this.current.pos.clone();
		let ply = this.current.ply;
		const parts: string[] = [];
		for (const uci of pv.slice(0, 8)) {
			const parsed = parseUci(uci);
			const move = parsed && normalizeMove(pos, parsed);
			if (!move || !pos.isLegal(move)) break;
			const white = ply % 2 === 0;
			const number = Math.floor(ply / 2) + 1;
			const prefix = white ? `${number}. ` : parts.length === 0 ? `${number}… ` : "";
			parts.push(prefix + makeSanAndPlay(pos, move));
			ply++;
		}
		return parts.join(" ");
	}

	private autoShapes(): DrawShape[] {
		const shapes: DrawShape[] = [];
		if (!this.hasLayout()) return shapes;
		const ev = this.evaluation;
		const enabled = this.engineOn && this.plugin.settings.engineEnabled && this.plugin.settings.showBestMove;
		if (enabled && ev && ev.fen === this.current.fen && ev.ev.pv[0]) {
			const best = ev.ev.pv[0];
			shapes.push({ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: "engine" });
		}
		const nag = this.study.moveNag(this.current.node);
		const uci = this.current.uci;
		if (nag && uci) shapes.push({ orig: uci.slice(2, 4) as Key, customSvg: { html: nagBadge(nag) } });
		return shapes;
	}

	// ---------------------------------------------------------------- writing back to the note

	private save() {
		if (this.readOnly) return;
		const next = this.study.serialize();
		this.rememberState(next);
		this.saving = this.saving
			.then(() => this.write(next))
			.catch(error => {
				console.error("Chess Study: could not save board", error);
				new Notice(`Chess Study: couldn't save the board. ${error instanceof Error ? error.message : ""}`);
			});
	}

	private async write(next: string) {
		const previous = this.source;
		if (next.trim() === previous.trim()) return;
		// Let chessground finish its queued redraw before the block is re-rendered.
		await new Promise(resolve => requestAnimationFrame(resolve));
		const { app } = this.plugin;
		const file = app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) throw new Error("The note was moved or deleted.");
		const lineHint = this.ctx.getSectionInfo(this.containerEl)?.lineStart;

		let editor: MarkdownView["editor"] | undefined;
		app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view;
			if (!editor && view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source") editor = view.editor;
		});

		if (editor) {
			const block = locateBlock(editor.getValue(), previous, lineHint);
			if (!block) throw new Error("The code block changed before it could be updated.");
			const text = block.lines(next).map(line => `${line}\n`).join("");
			editor.replaceRange(text, { line: block.start, ch: 0 }, { line: block.end, ch: 0 });
		} else {
			let found = false;
			await app.vault.process(file, data => {
				const block = locateBlock(data, previous, lineHint);
				if (!block) return data;
				found = true;
				const lines = data.split("\n");
				lines.splice(block.start, block.end - block.start, ...block.lines(next));
				return lines.join("\n");
			});
			if (!found) throw new Error("The code block changed before it could be updated.");
		}
		this.source = next;
	}
}

/**
 * Re-index `path` after the children of the node at `parent` were reordered. `map` gives each
 * child's new index, or undefined when the child was removed.
 */
export function remapPath(path: Path, parent: Path, map: (index: number) => number | undefined): Path {
	const at = parent.length;
	if (path.length <= at || parent.some((index, i) => path[i] !== index)) return path;
	const next = map(path[at]);
	return next === undefined ? path.slice(0, at) : [...path.slice(0, at), next, ...path.slice(at + 1)];
}

function formatScore(ev: Evaluation): string {
	if (ev.mate !== undefined) return ev.mate === 0 ? "#" : `#${ev.mate > 0 ? "" : "-"}${Math.abs(ev.mate)}`;
	const pawns = (ev.cp ?? 0) / 100;
	return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function nagBadge(nag: number): string {
	const { color } = NAG_STYLE[nag];
	const glyph = MOVE_NAGS[nag];
	const size = glyph.length > 1 ? 21 : 25;
	return `<g transform="translate(66 -8)">
<circle cx="21" cy="21" r="21" fill="rgba(0,0,0,0.25)" transform="translate(0 2)"/>
<circle cx="21" cy="21" r="20" fill="${color}" stroke="#fff" stroke-width="2.5"/>
<text x="21" y="22" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-weight="800" font-size="${size}" fill="#fff">${glyph}</text>
</g>`;
}

interface BlockLocation {
	/** First content line. */
	start: number;
	/** Closing fence line (exclusive end of the content). */
	end: number;
	/** Content lines with the block's quote or indent prefix applied. */
	lines: (content: string) => string[];
}

const OPEN_FENCE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/** Find the fenced block whose content is `source`, preferring the one opening at `lineHint`. */
export function locateBlock(text: string, source: string, lineHint?: number): BlockLocation | undefined {
	const lines = text.split("\n");
	const want = source.replace(/\r/g, "").trim();
	const matches: BlockLocation[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = OPEN_FENCE.exec(lines[i]);
		if (!open) continue;
		const [, prefix, fence, language] = open;
		let close = i + 1;
		const strip = (line: string) => (line.startsWith(prefix) ? line.slice(prefix.length) : line.startsWith(prefix.trimEnd()) ? line.slice(prefix.trimEnd().length) : line);
		while (close < lines.length) {
			const body = strip(lines[close]).trim();
			if (body.startsWith(fence[0].repeat(fence.length)) && /^(`+|~+)$/.test(body)) break;
			close++;
		}
		if (CODE_BLOCK_LANGUAGES.includes(language.toLowerCase())) {
			const content = lines.slice(i + 1, close).map(strip).join("\n").replace(/\r/g, "").trim();
			if (content === want) {
				matches.push({ start: i + 1, end: close, lines: next => next.split("\n").map(line => prefix + line) });
			}
		}
		i = close;
	}
	return matches.find(match => match.start - 1 === lineHint) ?? matches[0];
}
