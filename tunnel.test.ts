// Tests for cloudflared URL parsing + binary discovery. Run: bun test tunnel.test.ts
import { test, expect } from 'bun:test'
import { parseTunnelUrl, findCloudflared } from './tunnel.ts'

test('parses the trycloudflare URL out of cloudflared’s boxed banner', () => {
  const banner = [
    '2026-06-15T07:00:00Z INF +----------------------------------------------------------+',
    '2026-06-15T07:00:00Z INF |  Your quick Tunnel has been created! Visit it at:         |',
    '2026-06-15T07:00:00Z INF |  https://random-three-word-name.trycloudflare.com         |',
    '2026-06-15T07:00:00Z INF +----------------------------------------------------------+',
  ].join('\n')
  expect(parseTunnelUrl(banner)).toBe('https://random-three-word-name.trycloudflare.com')
})

test('ignores api.trycloudflare.com (the startup API host, not the tunnel) and unrelated URLs', () => {
  expect(parseTunnelUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel ...')).toBeNull()
  expect(parseTunnelUrl('connecting to https://example.com and 1.2.3.4')).toBeNull()
  expect(parseTunnelUrl('')).toBeNull()
})

test('still parses the real URL even if the api host appears in the same buffer', () => {
  const mixed = 'INF ...api.trycloudflare.com... \nINF |  https://blue-cat-runs-fast.trycloudflare.com  |'
  expect(parseTunnelUrl(mixed)).toBe('https://blue-cat-runs-fast.trycloudflare.com')
})

test('findCloudflared returns null when absent and honors an explicit existing path', () => {
  expect(findCloudflared('/nonexistent-state-dir')).toBeNull()
  expect(findCloudflared('/nonexistent-state-dir', '/definitely/not/here')).toBeNull()
  expect(findCloudflared('/tmp', '/bin/sh')).toBe('/bin/sh')   // any existing file path is honored
})
