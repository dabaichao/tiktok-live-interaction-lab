import { join } from "node:path";
import { build } from "vite";

/** Bundle npm-only imports (notably pako) before serving the browser client. */
export async function buildWebcastBrowserBundle(projectRoot: string): Promise<string> {
  const result = await build({
    configFile: false,
    root: projectRoot,
    logLevel: "warn",
    build: {
      write: false,
      target: "es2022",
      sourcemap: false,
      minify: "esbuild",
      lib: {
        entry: join(projectRoot, "tools", "douyin-admin", "webcast-client.js"),
        formats: ["es"],
        fileName: () => "index.mjs",
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => "output" in output ? output.output : []);
  const entry = chunks.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
  if (!entry || entry.type !== "chunk" || chunks.length !== 1 || entry.imports.length || entry.dynamicImports.length) {
    throw new Error("抖音连接脚本打包失败：必须包含所有浏览器依赖。");
  }
  return entry.code;
}
