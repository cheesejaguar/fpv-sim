// Types for bemt-inputs.mjs (imported by the test setup, tests/setup/propTables.ts).
export declare const BEMT_DIR: string;
export declare const MANIFEST: string;
export interface BemtManifestFile { format: 'fpvsim-bemt'; inputs: string; tables: Record<string, string>; stats?: unknown }
export declare function bemtInputHash(root: string): string;
export declare function readBemtManifest(root: string): BemtManifestFile | null;
export declare function currentBemtManifest(root: string): BemtManifestFile | null;
export declare function isBemtInput(root: string, file: string): boolean;
