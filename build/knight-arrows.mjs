import { readFile } from "fs/promises";

/**
 * Chessground draws every arrow as a straight line. This patches its SVG renderer so
 * knight moves are drawn as an L (long leg first, then the turn), like Brilliant Chess.
 * Drawing, erasing and the live preview while dragging all keep working, because only
 * the final <line> element is swapped for an equivalent <path>.
 */
const HOOK = "function renderLine(isHilite) {";

const L_SHAPE = `
function knightArrowPath(line, from, to) {
    if (line.tagName !== 'line') return line;
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const short = Math.min(ax, ay), long = Math.max(ax, ay);
    if (short < 0.01 || Math.abs(long / short - 2) > 0.01) return line;
    const corner = ax > ay ? [to[0], from[1]] : [from[0], to[1]];
    const margin = Math.hypot(to[0] - Number(line.getAttribute('x2')), to[1] - Number(line.getAttribute('y2')));
    const lx = to[0] - corner[0], ly = to[1] - corner[1], leg = Math.hypot(lx, ly);
    const end = [to[0] - (lx / leg) * margin, to[1] - (ly / leg) * margin];
    const path = createElement('path');
    for (const name of line.getAttributeNames()) if (!/^[xy][12]$/.test(name)) path.setAttribute(name, line.getAttribute(name));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', 'M' + from[0] + ',' + from[1] + ' L' + corner[0] + ',' + corner[1] + ' L' + end[0] + ',' + end[1]);
    return path;
}
`;

export const knightArrows = {
	name: "chessground-knight-arrows",
	setup(build) {
		build.onLoad({ filter: /chessground[\\/]dist[\\/]svg\.js$/ }, async args => {
			const code = await readFile(args.path, "utf8");
			if (!code.includes(HOOK) || !code.includes("function createElement(")) {
				throw new Error("knight-arrows: chessground's svg.js changed; update build/knight-arrows.mjs");
			}
			const patched = code.replace(
				HOOK,
				"function renderLine(isHilite) { return knightArrowPath(renderStraightLine(isHilite), from, to); }\n    function renderStraightLine(isHilite) {",
			);
			return { contents: patched + L_SHAPE, loader: "js" };
		});
	},
};
