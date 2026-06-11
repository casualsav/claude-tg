import { describe, test, expect } from 'bun:test'
import { parseGhAuthStatus } from './github.ts'

describe('parseGhAuthStatus', () => {
  test('multi-account format with active markers', () => {
    const out = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account bob (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************`
    expect(parseGhAuthStatus(out)).toEqual([
      { host: 'github.com', user: 'alice', active: true },
      { host: 'github.com', user: 'bob', active: false },
    ])
  })

  test('legacy single-account "as" format is active', () => {
    const out = `github.com
  ✓ Logged in to github.com as alice (oauth_token)
  ✓ Git operations for github.com configured to use https protocol.`
    expect(parseGhAuthStatus(out)).toEqual([{ host: 'github.com', user: 'alice', active: true }])
  })

  test('failed-login lines and not-logged-in output yield nothing', () => {
    expect(parseGhAuthStatus('X Failed to log in to github.com account bob (keyring)')).toEqual([])
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual([])
    expect(parseGhAuthStatus('')).toEqual([])
  })

  test('enterprise host parses alongside github.com', () => {
    const out = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true

ghe.example.com
  ✓ Logged in to ghe.example.com account alice-corp (keyring)
  - Active account: true`
    expect(parseGhAuthStatus(out)).toEqual([
      { host: 'github.com', user: 'alice', active: true },
      { host: 'ghe.example.com', user: 'alice-corp', active: true },
    ])
  })
})
