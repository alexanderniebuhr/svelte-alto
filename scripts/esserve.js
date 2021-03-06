const fs = require("fs");
const esbuild = require("esbuild");
const svelte = require("svelte/compiler");
const path = require("path");
const { preprocess } = require("../svelte.config.js");

const convertWarningFormat = ({ message, start, end, filename, frame }) => ({
  text: message,
  location: start &&
    end && {
      file: filename,
      line: start.line,
      column: start.column,
      length: start.line === end.line ? end.column - start.column : 0,
      lineText: frame,
    },
});

function sveltePlugin(options) {
  return {
    name: "nbhr-esbuild-svelte",
    setup(build) {
      //Store generated css code for use in fake import
      const cssCode = new Map();
      const fileCache = new Map();

      // main loader
      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        // if told to use the cache, check if it contains the file,
        // and if the modified time is not greater than the time when it was cached
        // if so, return the cached data
        if (options?.cache === true && fileCache.has(args.path)) {
          const cachedFile = fileCache.get(args.path);
          if (cachedFile && fs.statSync(args.path).mtime < cachedFile.time) {
            return cachedFile.data;
          }
        }

        let source = await fs.promises.readFile(args.path, "utf8");
        let filename = path.relative(process.cwd(), args.path);

        try {
          if (options?.preprocess) {
            source = (
              await svelte.preprocess(source, options.preprocess, { filename })
            ).code;
          }

          let compileOptions = { css: false, ...options?.compileOptions };

          let { js, css, warnings } = svelte.compile(source, {
            ...compileOptions,
            filename,
          });
          let contents = js.code + `\n//# sourceMappingURL=` + js.map.toUrl();

          //if svelte emits css seperately, then store it in a map and import it from the js
          if (!compileOptions.css && css.code) {
            let cssPath = args.path
              .replace(".svelte", ".esbuild-svelte-fake-css")
              .replace(/\\/g, "/");

            cssCode.set(
              cssPath,
              css.code + `/*# sourceMappingURL=${css.map.toUrl()}*/`
            );
            contents = contents + `\nimport "${cssPath}";`;
          }

          const result = {
            contents: contents,
            warnings: warnings.map(convertWarningFormat),
          };

          // if we are told to cache, then cache
          if (options?.cache === true) {
            fileCache.set(args.path, { data: result, time: new Date() });
          }
          return result;
        } catch (e) {
          return [convertWarningFormat(e)];
        }
      });

      // if the css exists in our map, then output it with the css loader
      build.onLoad({ filter: /\.esbuild-svelte-fake-css$/ }, (args) => {
        const css = cssCode.get(args.path);
        return css ? { contents: css, loader: "css" } : null;
      });
    },
  };
}

// ****************************************************************
// ********************************
// BUILD

// build the application
esbuild
  .serve(
    {
      servedir: "public",
      port: 8080,
      host: "0.0.0.0",
    },
    {
      entryPoints: ["src/index.js"],
      outdir: "public",
      format: "esm",
      // minify: true,
      bundle: true,
      // splitting: true,
      // incremental: true,
      plugins: [
        sveltePlugin({
          cache: false,
          compileOptions: { css: false },
          preprocess,
        }),
      ],
    }
  )
  .then((server) => {
    console.log(server);
    process.on("SIGINT", function () {
      server.stop();
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
