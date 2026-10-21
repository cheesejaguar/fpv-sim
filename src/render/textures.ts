// Procedural surface textures (canvas-generated so the project ships no binary art).
import * as THREE from 'three';
import { seededRandom } from '../maps/world';

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number, rnd: () => number) => void, seed: number, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size, seededRandom(seed));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function speckle(ctx: CanvasRenderingContext2D, s: number, rnd: () => number, n: number, colors: string[], rmax: number) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const r = rnd() * rmax + 0.5;
    ctx.fillRect(rnd() * s, rnd() * s, r, r * (0.5 + rnd() * 2));
  }
}

export function grassTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#4f6b2c'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, rnd, 26000, ['#5b7a32', '#456127', '#6b8a3a', '#3d5522', '#7a8f45', '#556e2e'], 2.2);
    for (let i = 0; i < 1800; i++) { ctx.strokeStyle = rnd() < 0.5 ? '#6f9440' : '#3f5a24'; ctx.beginPath(); const x = rnd() * s, y = rnd() * s; ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 5); ctx.stroke(); }
  }, 11, 1);
}
export function dirtTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#6e604c'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, rnd, 30000, ['#7a6a52', '#5e5241', '#857559', '#4f4536', '#8f8a7e', '#6a6a5e'], 2.5);
    for (let i = 0; i < 200; i++) { ctx.fillStyle = `rgba(60,70,40,${0.2 + rnd() * 0.3})`; ctx.beginPath(); ctx.arc(rnd() * s, rnd() * s, 2 + rnd() * 10, 0, 7); ctx.fill(); }
  }, 12, 1);
}
export function concreteTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#8d8a84'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, rnd, 22000, ['#99968f', '#827f79', '#77746f', '#a3a09a', '#6d6a65'], 1.6);
    for (let i = 0; i < 40; i++) { ctx.fillStyle = `rgba(40,38,35,${rnd() * 0.18})`; ctx.fillRect(rnd() * s, rnd() * s, 10 + rnd() * 80, 4 + rnd() * 60); }
    ctx.strokeStyle = 'rgba(30,30,30,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) { ctx.beginPath(); let x = rnd() * s, y = rnd() * s; ctx.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (rnd() - 0.5) * 30; y += (rnd() - 0.3) * 20; ctx.lineTo(x, y); } ctx.stroke(); }
    // graffiti tags
    const tags = ['#d43f3f', '#3f7fd4', '#e0c341', '#47b35a'];
    for (let i = 0; i < 3; i++) { ctx.strokeStyle = tags[i]; ctx.lineWidth = 4; ctx.beginPath(); let x = rnd() * s, y = 200 + rnd() * 200; ctx.moveTo(x, y); for (let k = 0; k < 10; k++) { x += rnd() * 20; y += (rnd() - 0.5) * 40; ctx.lineTo(x, y); } ctx.stroke(); }
  }, 13, 1);
}
export function brickTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#7a7268'; ctx.fillRect(0, 0, s, s);
    const bw = 64, bh = 24;
    for (let y = 0; y < s; y += bh) for (let x = -((y / bh) % 2) * bw / 2; x < s; x += bw) {
      const r = 120 + rnd() * 40, g = 55 + rnd() * 25, b = 40 + rnd() * 20;
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4);
    }
    speckle(ctx, s, rnd, 8000, ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.08)'], 2);
  }, 14, 1);
}
export function metalTexture() {
  return canvasTex(256, (ctx, s, rnd) => {
    ctx.fillStyle = '#7d8388'; ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x, 0, 3, s); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + 3, 0, 2, s); }
    for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(120,60,30,${rnd() * 0.35})`; ctx.beginPath(); ctx.arc(rnd() * s, rnd() * s, 2 + rnd() * 14, 0, 7); ctx.fill(); }
  }, 15, 1);
}
export function woodTexture() {
  return canvasTex(256, (ctx, s, rnd) => {
    ctx.fillStyle = '#9a7a52'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) { ctx.fillStyle = `rgba(70,45,20,${rnd() * 0.25})`; ctx.fillRect(0, y, s, 1); }
  }, 16, 1);
}
export function padTexture() {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#f5f5f5'; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.38, 0, 7); ctx.stroke();
    ctx.fillStyle = '#f5f5f5'; ctx.font = 'bold 120px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', s / 2, s / 2 + 6);
  }, 17, 1);
}
export function gateTexture(color: string) {
  return canvasTex(128, (ctx, s) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(0,0,0,0.85)'; for (let i = 0; i < 4; i++) ctx.fillRect(0, i * 32 + 12, s, 6);
  }, 18, 1);
}
/** Safety net: transparent mesh of light cord (10 cm cells at the 0.8 m world-UV texel used for it). */
export function netTexture() {
  return canvasTex(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(235,235,235,0.9)'; ctx.lineWidth = 2;
    for (let i = 0; i < s; i += 16) { ctx.beginPath(); ctx.moveTo(i + 1, 0); ctx.lineTo(i + 1, s); ctx.moveTo(0, i + 1); ctx.lineTo(s, i + 1); ctx.stroke(); }
  }, 19, 1);
}
/** Printed advertising board / video screen: '|' separates lines. Width:height follows the board. */
export function textTexture(text: string, bg: number, aspect: number, screen: boolean) {
  const w = 1024, h = Math.max(64, Math.min(1024, Math.round(w / Math.max(aspect, 0.25))));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const hex = '#' + bg.toString(16).padStart(6, '0');
  ctx.fillStyle = hex; ctx.fillRect(0, 0, w, h);
  const lines = text.split('|');
  if (screen) {
    // LED video wall: glowing frame and scanlines behind bright text
    const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#0d2a5c'); g.addColorStop(1, '#3a0d4f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#38e1ff'; ctx.lineWidth = Math.max(4, h * 0.03); ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, 0, w, h * 0.12); ctx.fillRect(0, h * 0.88, w, h * 0.12);
  }
  const size = Math.min((h * 0.8) / lines.length, (w * 1.6) / Math.max(...lines.map((l) => l.length)));
  ctx.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = h / 2 + (i - (lines.length - 1) / 2) * size * 1.05;
    if (screen) { ctx.shadowColor = '#7ff3ff'; ctx.shadowBlur = size * 0.2; ctx.fillStyle = i === 0 ? '#ffffff' : '#ffd84a'; }
    else ctx.fillStyle = '#ffffff';
    ctx.fillText(l, w / 2, y, w * 0.94);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
