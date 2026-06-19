declare module "*.scm" {
  const path: string
  export default path
}

declare module "*.wasm" {
  const path: string
  export default path
}

declare module "bun-ffi-structs" {
  export function defineStruct(...args: any[]): any
  export function defineEnum(...args: any[]): any
}

interface BunShims {
  stripANSI(text: string): string
  sleep(ms: number): Promise<void>
  write(destination: string | number, data: any): Promise<number>
  argv: string[]
}

declare var Bun: BunShims & typeof Bun
