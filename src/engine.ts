// @ts-ignore: bundled as text by esbuild
import stockfishSource from "../vendor/stockfish/stockfish-19-lite-single.worker.js";
// @ts-ignore: bundled as base64 by esbuild
import stockfishWasm from "../vendor/stockfish/stockfish-19-lite-single.wasm";

/** Score from White's point of view. */
export interface Evaluation {
	depth: number;
	/** Centipawns, White's perspective. */
	cp?: number;
	/** Moves to mate, positive when White mates. 0 means the side to move is mated. */
	mate?: number;
	/** Principal variation in UCI. */
	pv: string[];
}

interface Job {
	owner: string;
	fen: string;
	depth: number;
	onInfo: (ev: Evaluation) => void;
	resolve: (ev: Evaluation | undefined) => void;
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Obsidian desktop turns on Node integration in workers, which makes Stockfish.js
 * take its Node.js code path and never start. Hide the Node globals first, and
 * shadow the ones that cannot be deleted.
 */
const HIDE_NODE = `(() => {
	for (const key of ["process", "require", "module", "exports", "global", "__filename", "__dirname"]) {
		try { delete globalThis[key]; } catch (e) {}
		try { if (key in globalThis) Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true }); } catch (e) {}
	}
})();
(function (process, require, module, exports, global, __filename, __dirname) {
`;
const HIDE_NODE_END = "\n}).call(self);";

/**
 * One Stockfish worker shared by every board. Each board ("owner") has at most
 * one pending search: a new request from the same owner replaces the old one
 * and stops it if it is running.
 */
export class Engine {
	private worker?: Worker;
	private urls: string[] = [];
	private ready?: Promise<Worker>;
	private queue: Job[] = [];
	private current?: Job;
	private best?: Evaluation;
	private stopping = false;

	analyze(owner: string, fen: string, depth: number, onInfo: (ev: Evaluation) => void): Promise<Evaluation | undefined> {
		this.cancel(owner);
		return new Promise(resolve => {
			this.queue.push({ owner, fen, depth, onInfo, resolve });
			void this.pump();
		});
	}

	cancel(owner: string) {
		this.queue = this.queue.filter(job => {
			if (job.owner !== owner) return true;
			job.resolve(undefined);
			return false;
		});
		if (this.current?.owner === owner && !this.stopping) {
			this.stopping = true;
			this.worker?.postMessage("stop");
		}
	}

	dispose() {
		for (const job of this.queue) job.resolve(undefined);
		this.queue = [];
		this.current?.resolve(undefined);
		this.current = undefined;
		this.worker?.terminate();
		this.worker = undefined;
		this.ready = undefined;
		for (const url of this.urls) URL.revokeObjectURL(url);
		this.urls = [];
	}

	private start(): Promise<Worker> {
		if (this.ready) return this.ready;
		this.ready = new Promise<Worker>((resolve, reject) => {
			const wasmUrl = URL.createObjectURL(new Blob([decodeBase64(stockfishWasm as string)], { type: "application/wasm" }));
			const jsUrl = URL.createObjectURL(new Blob([HIDE_NODE, stockfishSource as string, HIDE_NODE_END], { type: "text/javascript" }));
			this.urls.push(wasmUrl, jsUrl);
			// Stockfish.js reads the wasm location from the worker URL's hash.
			const worker = new Worker(`${jsUrl}#${encodeURIComponent(wasmUrl)}`);
			const timer = window.setTimeout(() => fail(new Error("Stockfish did not start")), 20000);
			const fail = (error: unknown) => {
				window.clearTimeout(timer);
				worker.terminate();
				this.ready = undefined;
				reject(error);
			};
			const boot = (event: MessageEvent) => {
				if (typeof event.data !== "string") return;
				if (event.data.includes("uciok")) {
					worker.postMessage("setoption name Hash value 32");
					worker.postMessage("isready");
				} else if (event.data.includes("readyok")) {
					window.clearTimeout(timer);
					worker.removeEventListener("message", boot);
					worker.addEventListener("message", e => this.receive(e));
					this.worker = worker;
					resolve(worker);
				}
			};
			worker.addEventListener("message", boot);
			worker.addEventListener("error", e => fail(e));
			worker.postMessage("uci");
		});
		return this.ready;
	}

	private async pump() {
		if (this.current) return;
		const job = this.queue.shift();
		if (!job) return;
		this.current = job;
		this.best = undefined;
		this.stopping = false;
		let worker: Worker;
		try {
			worker = await this.start();
		} catch (error) {
			console.error("Chess Study: could not start Stockfish", error);
			job.resolve(undefined);
			this.current = undefined;
			void this.pump();
			return;
		}
		// The job may have been cancelled while the engine was booting.
		if (this.current !== job) return;
		if (this.stopping) {
			this.finish();
			return;
		}
		worker.postMessage(`position fen ${job.fen}`);
		worker.postMessage(`go depth ${job.depth}`);
	}

	private receive(event: MessageEvent) {
		if (typeof event.data !== "string") return;
		for (const line of event.data.split("\n")) {
			const job = this.current;
			if (!job) return;
			if (line.startsWith("bestmove")) {
				this.finish();
			} else if (line.startsWith("info") && line.includes(" pv ")) {
				const ev = parseInfo(line, job.fen);
				if (ev) {
					this.best = ev;
					if (!this.stopping) job.onInfo(ev);
				}
			}
		}
	}

	private finish() {
		const job = this.current;
		this.current = undefined;
		const stopped = this.stopping;
		this.stopping = false;
		// A search that was stopped early still returns its best line so it can be cached.
		job?.resolve(stopped ? (this.best ? { ...this.best, depth: Math.min(this.best.depth, job.depth) } : undefined) : this.best);
		this.best = undefined;
		void this.pump();
	}
}

function parseInfo(line: string, fen: string): Evaluation | undefined {
	const tokens = line.trim().split(/\s+/);
	if (tokens.includes("lowerbound") || tokens.includes("upperbound")) return;
	const multipv = valueAfter(tokens, "multipv");
	if (multipv && multipv !== "1") return;
	const depth = Number(valueAfter(tokens, "depth"));
	const scoreAt = tokens.indexOf("score");
	const pvAt = tokens.indexOf("pv");
	if (!depth || scoreAt < 0 || pvAt < 0) return;
	const sign = fen.split(" ")[1] === "b" ? -1 : 1;
	const kind = tokens[scoreAt + 1];
	const value = Number(tokens[scoreAt + 2]);
	const pv = tokens.slice(pvAt + 1);
	if (kind === "cp") return { depth, cp: value * sign, pv };
	if (kind === "mate") return { depth, mate: value * sign, pv };
}

function valueAfter(tokens: string[], key: string): string | undefined {
	const i = tokens.indexOf(key);
	return i >= 0 ? tokens[i + 1] : undefined;
}
