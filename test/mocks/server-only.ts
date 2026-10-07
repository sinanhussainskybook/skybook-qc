// Test replacement for the `server-only` package.
//
// Outside a React Server Components build, `server-only` throws on import —
// that is how it stops server code reaching the browser. Vitest is not such
// a build, so tests load this empty module instead (see vitest.config.mts).
// The real protection still applies in `npm run build`.
export {};
