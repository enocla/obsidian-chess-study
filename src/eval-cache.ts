import { debounce, type Plugin } from "obsidian";
import type { Evaluation } from "./engine";

interface CacheFile {
	version: 1;
	entries: [string, Evaluation][];
}

/** Position key without move counters, so transpositions share an entry. */
export function positionKey(fen: string): string {
	return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Evaluations keyed by position, stored in the plugin folder so they survive
 * restarts (and follow the vault when plugin folders sync). Least recently
 * used entries are dropped once the cache is full.
 */
export class EvalCache {
	private entries = new Map<string, Evaluation>();
	private dirty = false;
	private readonly path: string;
	readonly save = debounce(() => void this.flush(), 4000, true);

	constructor(private plugin: Plugin, private limit: () => number) {
		this.path = `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/eval-cache.json`;
	}

	get size() {
		return this.entries.size;
	}

	async load() {
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (!(await adapter.exists(this.path))) return;
			const data = JSON.parse(await adapter.read(this.path)) as CacheFile;
			if (data?.version !== 1 || !Array.isArray(data.entries)) return;
			// Entries computed during this session win over what is on disk.
			const loaded = new Map(data.entries);
			for (const [key, value] of this.entries) loaded.set(key, value);
			this.entries = loaded;
			this.trim();
		} catch (error) {
			console.warn("Chess Study: ignoring unreadable evaluation cache", error);
		}
	}

	get(fen: string): Evaluation | undefined {
		const key = positionKey(fen);
		const value = this.entries.get(key);
		if (value) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(fen: string, ev: Evaluation) {
		const key = positionKey(fen);
		const old = this.entries.get(key);
		if (old && old.depth > ev.depth) return;
		this.entries.delete(key);
		this.entries.set(key, { depth: ev.depth, cp: ev.cp, mate: ev.mate, pv: ev.pv.slice(0, 12) });
		this.trim();
		this.dirty = true;
		this.save();
	}

	async clear() {
		this.entries.clear();
		this.dirty = true;
		await this.flush();
	}

	async flush() {
		if (!this.dirty) return;
		this.dirty = false;
		const data: CacheFile = { version: 1, entries: [...this.entries] };
		try {
			await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(data));
		} catch (error) {
			this.dirty = true;
			console.warn("Chess Study: could not save evaluation cache", error);
		}
	}

	private trim() {
		const limit = Math.max(0, this.limit());
		while (this.entries.size > limit) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}
}
