// Map package validation errors, in a module of their own so the UI can recognise them without
// loading the package loader (mapFormat.ts is fetched on first use).
export class MapFormatError extends Error {
  constructor(readonly errors: string[], readonly warnings: string[] = []) {
    super(`invalid map package:\n  - ${errors.join('\n  - ')}`);
  }
}
