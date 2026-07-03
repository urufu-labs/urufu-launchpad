// Ambient declarations for Ponder's virtual modules. Once `ponder codegen` runs (after the
// contracts land on Sepolia + addresses are wired into ponder.config.ts), Ponder generates a
// richer version of this file with exact typed event args per contract. Until then, we keep
// broad types so `tsc --noEmit` passes without blocking scaffold work.

declare module 'ponder:registry' {
  interface PonderRegistry {
    on(event: string, handler: (args: { event: any; context: any }) => void | Promise<void>): void;
  }
  export const ponder: PonderRegistry;
}

declare module 'ponder:schema' {
  export const launches: unknown;
  export const holders: unknown;
  export const transfers: unknown;
}
