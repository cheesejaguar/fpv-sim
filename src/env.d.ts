/** Content hash of public/bf/betaflight.{mjs,wasm}, injected by vite.config.ts. */
declare const __FW_VERSION__: string;

// Build constants injected by vite.config.ts (`define`).
interface ImportMetaEnv {
  /** package.json version + short commit, e.g. "0.1.0+1a2b3c4" (just the version when the commit is unknown). */
  readonly VITE_APP_VERSION: string;
  /** Full commit SHA of the build, or "" when unknown. */
  readonly VITE_APP_COMMIT: string;
}
