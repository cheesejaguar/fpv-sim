// What the share sheet offers, and doing it. No web API posts to Instagram Stories: on a phone the
// Web Share API (Level 2, files) hands the PNG to the system share sheet, where Instagram offers
// Stories. Desktop browsers have no Instagram target, so there the card is downloaded, copied, or
// sent to the pilot's phone with a QR code (link.ts). navigator.share needs a click, tap or key
// press: it is called straight from the button's handler, with the PNG built beforehand.

export interface ShareEnv {
  /** navigator.canShare({ files: [png] }) */
  canShareFiles: boolean;
  /** a phone or tablet (no mouse / trackpad, or a mobile user agent) */
  mobile: boolean;
  /** an image can be written to the clipboard (Clipboard API + ClipboardItem) */
  clipboardImage: boolean;
  /** this page is the phone share page (no "send to my phone" there) */
  phonePage?: boolean;
}

/** Why "Send to my phone" can't be offered: the lap needs posting first, or it can't be. */
export type PhoneLink = 'ok' | 'post' | 'no-board' | 'custom-relay';

export interface ShareUi {
  /** the main button: Instagram (phones), the system share sheet (desktops that have one), or none */
  primary: { kind: 'instagram' | 'system'; label: string; hint: string } | null;
  copy: boolean;
  /** "Send to my phone": shown (with this state) or not at all */
  phone: PhoneLink | null;
}

export function shareUi(env: ShareEnv, phone: PhoneLink): ShareUi {
  const primary = !env.canShareFiles ? null
    : env.mobile ? { kind: 'instagram' as const, label: 'Share to Instagram', hint: 'Your share sheet opens: pick Instagram, then Story (on Android: “Stories”).' }
      : { kind: 'system' as const, label: 'Share…', hint: 'Opens your computer’s share sheet. Instagram Stories needs the phone app: use Send to my phone.' };
  return { primary, copy: env.clipboardImage, phone: env.phonePage ? null : phone };
}

export function detectEnv(file: File | null, phonePage = false): ShareEnv {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  let canShareFiles = false;
  try { canShareFiles = !!file && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] }); } catch { /* not allowed here */ }
  const coarse = typeof matchMedia === 'function' && !matchMedia('(any-pointer: fine)').matches;
  const mobile = coarse || nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(nav.userAgent);
  const CI = (globalThis as { ClipboardItem?: { supports?: (t: string) => boolean } }).ClipboardItem;
  const clipboardImage = !!CI && typeof nav.clipboard?.write === 'function' && (typeof CI.supports !== 'function' || CI.supports('image/png'));
  return { canShareFiles, mobile, clipboardImage, phonePage };
}

export type ShareOutcome = 'shared' | 'cancelled' | 'blocked' | 'failed';

/**
 * Open the share sheet. Call it synchronously from a click / key handler (transient activation).
 * For Instagram, send the image alone: a text alongside can turn it into a text share some apps skip.
 */
export function shareFile(file: File, text = ''): Promise<ShareOutcome> {
  let p: Promise<void>;
  try { p = navigator.share({ files: [file], title: 'My FPV Sim lap', ...(text ? { text } : {}) }); } catch (e) { return Promise.resolve(outcome(e)); }
  return p.then(() => 'shared' as const, outcome);
}

/** AbortError: the pilot closed the sheet; NotAllowedError: no click / key press behind the call (a controller button). */
function outcome(e: unknown): ShareOutcome {
  const n = (e as { name?: string })?.name;
  return n === 'AbortError' ? 'cancelled' : n === 'NotAllowedError' ? 'blocked' : 'failed';
}

export function downloadFile(file: File) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Copy the PNG. Safari wants the ClipboardItem made within the click: it takes the blob as a promise. */
export async function copyImage(blob: Blob | Promise<Blob>): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch { return false; }
}

/** fpv-sim-grand-prix-stadium-0-45-123-stats.png */
export function fileName(track: string, lapText: string, style: string): string {
  const slug = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `fpv-sim-${[slug(track), slug(lapText), slug(style)].filter(Boolean).join('-')}.png`;
}
