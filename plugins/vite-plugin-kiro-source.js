/*
 * vite-plugin-kiro-source
 *
 * Dev-only Vite plugin. Runs babel-plugin-kiro-source over .jsx/.tsx files so
 * every rendered element carries `data-kiro-source="file:line:col"`, giving the
 * Select-to-Edit overlay high-confidence source mapping.
 *
 * Requires (devDependencies in your project):
 *   @babel/core, @babel/preset-typescript
 *
 * Usage in vite.config.ts / .js:
 *   import kiroSource from './path/to/vite-plugin-kiro-source.js'
 *   export default defineConfig({ plugins: [react(), kiroSource()] })
 */
const babel = require("@babel/core");
const kiroBabel = require("./babel-plugin-kiro-source.js");

module.exports = function vitePluginKiroSource(options = {}) {
  let root = process.cwd();
  const include = options.include || /\.(jsx|tsx)$/;

  return {
    name: "vite-plugin-kiro-source",
    apply: "serve", // dev only — never in production build
    enforce: "pre",
    configResolved(config) {
      root = config.root || root;
    },
    async transform(code, id) {
      if (id.includes("node_modules")) return null;
      if (!include.test(id)) return null;

      const isTsx = /\.tsx$/.test(id);
      try {
        const result = await babel.transformAsync(code, {
          filename: id,
          root,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          parserOpts: {
            plugins: ["jsx", ...(isTsx || /\.ts$/.test(id) ? ["typescript"] : [])],
          },
          presets: [
            [require.resolve("@babel/preset-typescript"), { isTSX: isTsx, allExtensions: true }],
          ],
          plugins: [[kiroBabel, { root }]],
        });
        if (!result || result.code == null) return null;
        return { code: result.code, map: result.map };
      } catch (err) {
        // Don't break the dev server if a file fails to transform.
        this.warn(`[kiro-source] skipped ${id}: ${err.message}`);
        return null;
      }
    },
  };
};
