// App version, the "Report a bug" link (a prefilled GitHub issue) and the About screen's facts.
// VITE_APP_VERSION / VITE_APP_COMMIT are defined at build time; a plain dev server has neither.

export const REPO_URL = 'https://github.com/cheesejaguar/fpv-sim';

// (written out in full so Vite replaces them statically)
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || 'dev';
export const APP_COMMIT: string = import.meta.env.VITE_APP_COMMIT || '';

/** "v0.2.0 · 1a2b3c4", "v0.2.0" or "dev" for the footer / About screen. */
export function versionLabel(version = APP_VERSION, commit = APP_COMMIT): string {
  const v = version === 'dev' ? 'dev' : `v${version.replace(/^v/, '')}`;
  return commit ? `${v} · ${commit.slice(0, 7)}` : v;
}

export const commitUrl = (commit = APP_COMMIT) => (commit ? `${REPO_URL}/commit/${encodeURIComponent(commit)}` : '');

export interface BugInfo { version: string; commit: string; userAgent: string; gpu: string; controller: string; page: string }

/** New-issue URL with the title and an environment block filled in (the pilot reviews it on GitHub). */
export function bugReportUrl(i: BugInfo): string {
  const body = [
    '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '1. ', '',
    '---',
    `- Version: ${versionLabel(i.version, i.commit)}`,
    `- Browser: ${i.userAgent}`,
    `- GPU: ${i.gpu || 'unknown'}`,
    `- Controller: ${i.controller || 'none (keyboard)'}`,
    `- Page: ${i.page}`,
  ].join('\n');
  const q = new URLSearchParams({ title: `Bug: `, body, labels: 'bug' });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}

let gpuName: string | null = null;
/** The GPU, from WEBGL_debug_renderer_info (falls back to the masked renderer string). Cached. */
export function gpuRenderer(): string {
  if (gpuName !== null) return gpuName;
  gpuName = '';
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL */ }
  return gpuName;
}
