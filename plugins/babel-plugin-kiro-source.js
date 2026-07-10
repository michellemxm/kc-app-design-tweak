/*
 * babel-plugin-kiro-source
 *
 * Injects `data-kiro-source="relativeFile:line:col"` onto every JSX element in
 * DEV builds so the Select-to-Edit overlay can map a clicked DOM node back to
 * the exact source location — the high-confidence mapping path.
 *
 * Use via the Vite wrapper (vite-plugin-kiro-source.js) or directly in a Babel
 * config for dev. Never enable in production builds.
 */
const path = require("path");

module.exports = function kiroSourcePlugin({ types: t }) {
  return {
    name: "kiro-source",
    visitor: {
      JSXOpeningElement(nodePath, state) {
        const node = nodePath.node;

        // Skip if we've already tagged this node.
        const already = node.attributes.some(
          (a) =>
            a.type === "JSXAttribute" &&
            a.name &&
            a.name.name === "data-kiro-source"
        );
        if (already) return;

        // Need a source location to tag.
        const loc = node.loc || (node.name && node.name.loc);
        if (!loc || !loc.start) return;

        // Skip fragments (<>…</>) — they render nothing.
        if (node.name && node.name.type === "JSXMemberExpression") {
          // still fine to tag member expressions like <Foo.Bar>
        }

        const filename = (state.file && state.file.opts.filename) || "unknown";
        const root = (state.opts && state.opts.root) || process.cwd();
        let rel;
        try {
          rel = path.relative(root, filename) || filename;
        } catch (_) {
          rel = filename;
        }
        // Normalise Windows separators for a stable, URL-ish path.
        rel = rel.split(path.sep).join("/");

        const value = `${rel}:${loc.start.line}:${loc.start.column + 1}`;
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-kiro-source"),
            t.stringLiteral(value)
          )
        );
      },
    },
  };
};
