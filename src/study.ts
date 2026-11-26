import { Chess, normalizeMove, type Position } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import {
	ChildNode,
	type Comment,
	type CommentShape,
	emptyHeaders,
	type Game,
	makeComment,
	makePgn,
	Node,
	parseComment,
	parsePgn,
	type PgnNodeData,
	setStartingPosition,
	startingPosition,
} from "chessops/pgn";
import { makeSanAndPlay, parseSan } from "chessops/san";
import type { Move } from "chessops/types";
import { makeSquare, makeUci, squareFile, squareRank } from "chessops/util";

export type Path = number[];

export const MOVE_NAGS: Record<number, string> = { 1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!" };
export const NAG_BY_SYMBOL: Record<string, number> = { "!": 1, "?": 2, "!!": 3, "??": 4, "!?": 5, "?!": 6 };

/** One ply on the path from the start position to the current node. */
export interface Step {
	node: Node<PgnNodeData>;
	/** Position after this node's move (the start position for the root). */
	pos: Position;
	fen: string;
	/** UCI of the move that led here. */
	uci?: string;
	san?: string;
	ply: number;
}

export class Study {
	game: Game<PgnNodeData>;
	readonly start: Position;
	readonly startPly: number;
	readonly error?: string;
	private readonly hadResult: boolean;

	constructor(game: Game<PgnNodeData>, start: Position, error?: string) {
		this.game = game;
		this.start = start;
		this.error = error;
		this.hadResult = game.headers.has("Result");
		const fen = game.headers.get("FEN");
		const fullmoves = fen ? Number(fen.trim().split(/\s+/)[5]) || 1 : 1;
		this.startPly = (fullmoves - 1) * 2 + (start.turn === "black" ? 1 : 0);
	}

	static parse(source: string): Study {
		const text = source.trim();
		// A bare FEN is accepted as a starting position.
		if (text && !text.includes("\n") && looksLikeFen(text)) {
			const setup = parseFen(text);
			if (setup.isOk) {
				const pos = Chess.fromSetup(setup.value);
				if (pos.isOk) {
					const game: Game<PgnNodeData> = { headers: emptyHeaders(), moves: new Node() };
					setStartingPosition(game.headers, pos.value);
					return new Study(game, pos.value);
				}
			}
		}
		const game = parsePgn(text, emptyHeaders)[0] ?? { headers: emptyHeaders(), moves: new Node() };
		const start = startingPosition(game.headers);
		if (start.isErr) return new Study({ headers: emptyHeaders(), moves: new Node() }, Chess.default(), `Invalid FEN: ${start.error.message}`);
		const study = new Study(game, start.value as Position);
		const bad = study.firstIllegalMove();
		return bad ? new Study(game, start.value as Position, bad) : study;
	}

	serialize(): string {
		let pgn = makePgn(this.game).trim();
		if (!this.hadResult) pgn = pgn.replace(/\s*\*$/, "");
		return pgn;
	}

	/** Walk a path, stopping early at any index that does not exist. */
	steps(path: Path): Step[] {
		const steps: Step[] = [{ node: this.game.moves, pos: this.start, fen: makeFen(this.start.toSetup()), ply: this.startPly }];
		let node = this.game.moves;
		let pos = this.start;
		for (const index of path) {
			const child = node.children[index];
			if (!child) break;
			const move = parseSan(pos, child.data.san);
			if (!move) break;
			const uci = displayUci(pos, move);
			pos = pos.clone();
			const san = makeSanAndPlay(pos, move);
			node = child;
			steps.push({ node: child, pos, fen: makeFen(pos.toSetup()), uci, san, ply: steps[steps.length - 1].ply + 1 });
		}
		return steps;
	}

	/** Clip a path to nodes that exist and contain legal moves. */
	validPath(path: Path): Path {
		return path.slice(0, this.steps(path).length - 1);
	}

	node(path: Path): Node<PgnNodeData> {
		const steps = this.steps(path);
		return steps[steps.length - 1].node;
	}

	mainlinePath(from: Path = []): Path {
		const path = [...from];
		let node = this.node(path);
		while (node.children.length) {
			path.push(0);
			node = node.children[0];
		}
		return path;
	}

	/** Play a move after the node at `path`. Returns the path of the resulting node. */
	play(path: Path, move: Move): Path {
		const steps = this.steps(path);
		const { node, pos } = steps[steps.length - 1];
		const uci = makeUci(normalizeMove(pos, move));
		const existing = node.children.findIndex(child => {
			const m = parseSan(pos, child.data.san);
			return m && makeUci(normalizeMove(pos, m)) === uci;
		});
		const base = path.slice(0, steps.length - 1);
		if (existing >= 0) return [...base, existing];
		const san = makeSanAndPlay(pos.clone(), move);
		node.children.push(new ChildNode<PgnNodeData>({ san }));
		return [...base, node.children.length - 1];
	}

	/** Delete the node at `path` and everything after it. Returns the parent's path. */
	delete(path: Path): Path {
		if (!path.length) return path;
		const parent = this.node(path.slice(0, -1));
		parent.children.splice(path[path.length - 1], 1);
		return path.slice(0, -1);
	}

	/** Move the variation containing `path` one level closer to the main line. */
	promote(path: Path): Path {
		const at = findLastIndex(path, index => index > 0);
		if (at < 0) return path;
		const parent = this.node(path.slice(0, at));
		const [child] = parent.children.splice(path[at], 1);
		parent.children.unshift(child);
		const next = [...path];
		next[at] = 0;
		return next;
	}

	canPromote(path: Path): boolean {
		return path.some(index => index > 0);
	}

	toggleNag(path: Path, nag: number) {
		const node = this.node(path);
		if (!(node instanceof ChildNode)) return;
		const had = node.data.nags?.includes(nag);
		const rest = (node.data.nags ?? []).filter((n: number) => !(n in MOVE_NAGS));
		node.data.nags = had ? rest : [nag, ...rest];
		if (!node.data.nags.length) delete node.data.nags;
	}

	moveNag(node: Node<PgnNodeData>): number | undefined {
		if (!(node instanceof ChildNode)) return;
		return node.data.nags?.find((n: number) => n in MOVE_NAGS);
	}

	comment(path: Path): Comment {
		return parseComment(this.rawComments(this.node(path)).join(" "));
	}

	updateComment(path: Path, update: Partial<Comment>) {
		const node = this.node(path);
		const next = makeComment({ ...this.comment(path), ...update }).trim();
		const comments = next ? [next] : undefined;
		if (node instanceof ChildNode) {
			if (comments) node.data.comments = comments;
			else delete node.data.comments;
		} else {
			this.game.comments = comments;
		}
	}

	setShapes(path: Path, shapes: CommentShape[]) {
		this.updateComment(path, { shapes });
	}

	rawComments(node: Node<PgnNodeData>): string[] {
		return node instanceof ChildNode ? node.data.comments ?? [] : this.game.comments ?? [];
	}

	private firstIllegalMove(): string | undefined {
		const visit = (node: Node<PgnNodeData>, pos: Position): string | undefined => {
			for (const child of node.children) {
				const move = parseSan(pos, child.data.san);
				if (!move) return `Illegal move: ${child.data.san}`;
				const next = pos.clone();
				next.play(move);
				const error = visit(child, next);
				if (error) return error;
			}
		};
		return visit(this.game.moves, this.start);
	}
}

/** UCI with castling written as the king's two-square move, as boards display it. */
function displayUci(pos: Position, move: Move): string {
	if ("from" in move) {
		const piece = pos.board.get(move.from);
		const target = pos.board.get(move.to);
		if (piece?.role === "king" && target?.role === "rook" && target.color === piece.color) {
			const file = squareFile(move.to) > squareFile(move.from) ? 6 : 2;
			return makeSquare(move.from) + makeSquare(file + 8 * squareRank(move.from));
		}
	}
	return makeUci(move);
}

function looksLikeFen(text: string): boolean {
	return /^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7}(\s|$)/.test(text);
}

function findLastIndex<T>(items: T[], test: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
	return -1;
}
