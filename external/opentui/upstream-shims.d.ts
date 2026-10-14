declare module "*.scm" {
  const path: string
  export default path
}

declare module "*.wasm" {
  const path: string
  export default path
}

interface BunShims {
  stripANSI(text: string): string
  sleep(ms: number): Promise<void>
  write(destination: string | number, data: any): Promise<number>
  argv: string[]
}

declare var Bun: BunShims & typeof Bun

/** Bun 运行时提供的 `import.meta.main`（内置 fork 的 tree-sitter 资产脚本用到）。 */
interface ImportMeta {
  main?: boolean
}
