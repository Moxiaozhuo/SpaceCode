// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The local-filesystem surface of the H5 server (`/api/fs/*`) — the part a
 * paired phone uses to browse a project, and the part that reads whatever the
 * request names.
 *
 * These cases run against a *real* temp tree rather than a stubbed `fs`, so the
 * failure modes are the OS's own (ENOENT, ENOTDIR, dangling links, non-UTF-8
 * bytes) instead of a mock's opinion of them.
 *
 * The routes always answer 200 and put the failure in the payload
 * (`[]` / `null`), which the assertions below treat as the contract.
 */

vi.mock('electron', async () => {
  const { electronMock } = await import('./h5TestKit')
  return electronMock
})

vi.mock('../../infra/logger', async () => {
  const { loggerStub } = await import('./h5TestKit')
  return loggerStub
})

vi.mock('../../engine/engineGateway', async () => {
  const { gatewayStub } = await import('./h5TestKit')
  return { engineGateway: gatewayStub, NotImplementedError: class NotImplementedError extends Error {} }
})

vi.mock('../../engine/engines/EngineFactory', async () => {
  const { engineFactoryStub } = await import('./h5TestKit')
  return { EngineFactory: engineFactoryStub }
})

vi.mock('../../session/sessionHistoryManager', async () => {
  const { historyStub } = await import('./h5TestKit')
  return { SessionHistoryManager: historyStub }
})

import { H5Server } from '../h5Server'
import {
  TEST_TOKEN,
  auth,
  jsonOf,
  loggerStub,
  rawRequest,
  resetEngineFactoryStub,
  resetGatewayStub,
  resetHistoryStub,
  resetRuntime,
  type RawResponse,
} from './h5TestKit'

interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
}

interface SearchEntry extends DirEntry {
  relativePath: string
}

interface StatResult {
  size: number
  isDirectory: boolean
  isFile: boolean
  mtime: number
}

describe('H5Server filesystem routes', () => {
  let server: H5Server
  let port = 0
  let root = ''

  function pathIn(...parts: string[]): string {
    return join(root, ...parts)
  }

  async function fsCall(route: string, body: Record<string, unknown>): Promise<RawResponse> {
    return rawRequest({
      port,
      path: route,
      method: 'POST',
      body,
      token: TEST_TOKEN,
    })
  }

  async function payload(route: string, body: Record<string, unknown>): Promise<unknown> {
    return jsonOf(await fsCall(route, body))
  }

  beforeEach(async () => {
    resetRuntime()
    resetGatewayStub()
    resetHistoryStub()
    resetEngineFactoryStub()
    vi.clearAllMocks()

    root = mkdtempSync(join(tmpdir(), 'spacecode-h5fs-'))
    mkdirSync(pathIn('src', 'nested', 'deeper'), { recursive: true })
    mkdirSync(pathIn('node_modules', 'left-pad'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(pathIn('empty'), { recursive: true })
    writeFileSync(pathIn('alpha.txt'), 'alpha content', 'utf-8')
    writeFileSync(pathIn('beta.md'), '# beta', 'utf-8')
    writeFileSync(pathIn('.hidden.txt'), 'hidden', 'utf-8')
    writeFileSync(pathIn('.claude', 'settings.json'), '{}', 'utf-8')
    writeFileSync(pathIn('src', 'deepFile.ts'), 'export const a = 1', 'utf-8')
    writeFileSync(pathIn('src', 'nested', 'DeepThing.ts'), 'nested match', 'utf-8')
    writeFileSync(pathIn('src', 'nested', 'deeper', 'deepest.ts'), 'deep match', 'utf-8')
    writeFileSync(pathIn('node_modules', 'left-pad', 'index.js'), 'should be ignored', 'utf-8')
    writeFileSync(pathIn('.git', 'config'), 'should be ignored', 'utf-8')
    writeFileSync(pathIn('logo.png'), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x41, 0x42]))

    server = new H5Server(auth)
    port = (await server.start(0)).port
  })

  afterEach(() => {
    server.stop()
    rmSync(root, { recursive: true, force: true })
  })

  describe('/api/fs/read-dir', () => {
    it('lists entries with their kind resolved', async () => {
      const entries = (await payload('/api/fs/read-dir', { path: root })) as DirEntry[]

      const names = entries.map((e) => e.name).sort()
      expect(names).toEqual([
        '.claude',
        '.git',
        '.hidden.txt',
        'alpha.txt',
        'beta.md',
        'empty',
        'logo.png',
        'node_modules',
        'src',
      ])
      const file = entries.find((e) => e.name === 'alpha.txt')
      expect(file).toMatchObject({ path: pathIn('alpha.txt'), isFile: true, isDirectory: false })
      const dir = entries.find((e) => e.name === 'src')
      expect(dir).toMatchObject({ isDirectory: true, isFile: false })
    })

    it('answers an empty list for a directory that does not exist', async () => {
      const entries = (await payload('/api/fs/read-dir', { path: pathIn('nope') })) as DirEntry[]

      expect(entries).toEqual([])
      expect(loggerStub.warn).toHaveBeenCalledWith('H5Server', expect.stringContaining('readDir failed'))
    })

    it('answers an empty list when the path is a file, not a directory', async () => {
      const entries = (await payload('/api/fs/read-dir', { path: pathIn('alpha.txt') })) as DirEntry[]

      expect(entries).toEqual([])
    })

    it('answers an empty list when no path is supplied at all', async () => {
      expect(await payload('/api/fs/read-dir', {})).toEqual([])
      expect(await payload('/api/fs/read-dir', { path: '' })).toEqual([])
      expect(await payload('/api/fs/read-dir', { path: 42 })).toEqual([])
    })

    it('reports a symlink as neither file nor directory', async () => {
      symlinkSync(pathIn('alpha.txt'), pathIn('link-to-alpha'))

      const entries = (await payload('/api/fs/read-dir', { path: root })) as DirEntry[]
      const link = entries.find((e) => e.name === 'link-to-alpha')

      expect(link).toMatchObject({ isFile: false, isDirectory: false })
    })

    it('keeps the listing cheap for a large directory', async () => {
      const big = pathIn('big')
      mkdirSync(big, { recursive: true })
      for (let i = 0; i < 600; i += 1) writeFileSync(join(big, `f${i}.txt`), 'x', 'utf-8')

      const entries = (await payload('/api/fs/read-dir', { path: big })) as DirEntry[]

      expect(entries).toHaveLength(600)
    })
  })

  describe('/api/fs/read-file', () => {
    it('returns the text body', async () => {
      const res = await fsCall('/api/fs/read-file', { path: pathIn('beta.md') })

      expect(res.status).toBe(200)
      expect(res.body).toBe(JSON.stringify('# beta'))
    })

    it('answers null for a missing file', async () => {
      expect(await payload('/api/fs/read-file', { path: pathIn('ghost.txt') })).toBeNull()
    })

    it('answers null when the path is absent or not a string', async () => {
      expect(await payload('/api/fs/read-file', {})).toBeNull()
      expect(await payload('/api/fs/read-file', { path: ['a'] })).toBeNull()
    })

    it('answers null when asked to read a directory', async () => {
      expect(await payload('/api/fs/read-file', { path: pathIn('src') })).toBeNull()
    })

    it('lossily decodes binary content as utf-8 text', async () => {
      const text = (await payload('/api/fs/read-file', { path: pathIn('logo.png') })) as string

      expect(typeof text).toBe('string')
      expect(text).toContain('\uFFFD')
      expect(text.endsWith('AB')).toBe(true)
    })

    it('follows a symlink to its target', async () => {
      symlinkSync(pathIn('alpha.txt'), pathIn('link.txt'))

      expect(await payload('/api/fs/read-file', { path: pathIn('link.txt') })).toBe('alpha content')
    })

    it('answers null for a dangling symlink', async () => {
      symlinkSync(pathIn('nowhere'), pathIn('broken-link.txt'))

      expect(await payload('/api/fs/read-file', { path: pathIn('broken-link.txt') })).toBeNull()
    })

    it('reads any absolute path the request names — the token is the only gate', async () => {
      const outside = pathIn('..', 'spacecode-outside-read.txt')
      writeFileSync(outside, 'outside the browsed project', 'utf-8')

      expect(await payload('/api/fs/read-file', { path: outside })).toBe('outside the browsed project')

      rmSync(outside, { force: true })
    })
  })

  describe('/api/fs/read-file-base64', () => {
    it('round-trips binary bytes exactly', async () => {
      const original = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x41, 0x42])

      const encoded = (await payload('/api/fs/read-file-base64', { path: pathIn('logo.png') })) as string

      expect(Buffer.from(encoded, 'base64').equals(original)).toBe(true)
    })

    it('answers null for a missing file or a missing path', async () => {
      expect(await payload('/api/fs/read-file-base64', { path: pathIn('ghost.bin') })).toBeNull()
      expect(await payload('/api/fs/read-file-base64', {})).toBeNull()
    })
  })

  describe('/api/fs/stat', () => {
    it('describes a file', async () => {
      const stat = (await payload('/api/fs/stat', { path: pathIn('alpha.txt') })) as StatResult

      expect(stat).toMatchObject({ size: 'alpha content'.length, isFile: true, isDirectory: false })
      expect(stat.mtime).toBeGreaterThan(0)
    })

    it('describes a directory', async () => {
      const stat = (await payload('/api/fs/stat', { path: pathIn('src') })) as StatResult

      expect(stat).toMatchObject({ isDirectory: true, isFile: false })
    })

    it('answers null for a missing path', async () => {
      expect(await payload('/api/fs/stat', { path: pathIn('ghost') })).toBeNull()
      expect(await payload('/api/fs/stat', {})).toBeNull()
    })

    it('stats the symlink target rather than the link itself', async () => {
      symlinkSync(pathIn('alpha.txt'), pathIn('link2.txt'))

      const stat = (await payload('/api/fs/stat', { path: pathIn('link2.txt') })) as StatResult

      expect(stat).toMatchObject({ isFile: true, size: 'alpha content'.length })
    })
  })

  describe('/api/fs/search-files', () => {
    it('lists the top level when the query is empty, dirs first', async () => {
      const entries = (await payload('/api/fs/search-files', { path: root, query: '' })) as SearchEntry[]

      expect(entries.map((e) => e.name)).toEqual([
        '.claude',
        'empty',
        'src',
        'alpha.txt',
        'beta.md',
        'logo.png',
      ])
      expect(entries[0]).toMatchObject({ relativePath: '.claude', path: pathIn('.claude') })
      expect(entries.some((e) => e.name === '.git')).toBe(false)
      expect(entries.some((e) => e.name === 'node_modules')).toBe(false)
      expect(entries.some((e) => e.name === '.hidden.txt')).toBe(false)
    })

    it('finds matches in nested directories with forward-slash relative paths', async () => {
      const entries = (await payload('/api/fs/search-files', {
        path: root,
        query: 'deep',
      })) as SearchEntry[]

      const names = entries.map((e) => e.name).sort()
      expect(names).toEqual(['DeepThing.ts', 'deepFile.ts', 'deeper', 'deepest.ts'])
      const deepest = entries.find((e) => e.name === 'deepest.ts')
      expect(deepest?.relativePath).toBe(join('src', 'nested', 'deeper', 'deepest.ts').replace(/\\/g, '/'))
    })

    it('ranks an exact name hit above a prefix hit above a substring hit', async () => {
      writeFileSync(pathIn('src', 'deep'), 'exact name', 'utf-8')

      const entries = (await payload('/api/fs/search-files', { path: pathIn('src'), query: 'deep' })) as SearchEntry[]

      expect(entries[0].name).toBe('deep')
      expect(entries.map((e) => e.name).indexOf('deepFile.ts')).toBeLessThan(
        entries.map((e) => e.name).indexOf('DeepThing.ts'),
      )
    })

    it('puts a directory ahead of a file when both match the name exactly', async () => {
      writeFileSync(pathIn('src', 'deep'), 'exact file hit', 'utf-8')
      mkdirSync(pathIn('src', 'nested', 'deep'), { recursive: true })

      const entries = (await payload('/api/fs/search-files', {
        path: pathIn('src'),
        query: 'deep',
      })) as SearchEntry[]

      const exact = entries.filter((e) => e.name.toLowerCase() === 'deep')
      expect(exact).toHaveLength(2)
      expect(exact[0]).toMatchObject({ isDirectory: true, relativePath: 'nested/deep' })
      expect(exact[1]).toMatchObject({ isDirectory: false, relativePath: 'deep' })
    })

    it('matches case-insensitively', async () => {
      const entries = (await payload('/api/fs/search-files', { path: root, query: 'ALPHA' })) as SearchEntry[]

      expect(entries.map((e) => e.name)).toEqual(['alpha.txt'])
    })

    it('matches on the relative path as well as the name', async () => {
      const entries = (await payload('/api/fs/search-files', {
        path: root,
        query: 'nested/deeper',
      })) as SearchEntry[]

      expect(entries.length).toBeGreaterThan(0)
      expect(entries.every((e) => e.relativePath.toLowerCase().includes('nested/deeper'))).toBe(true)
    })

    it('caps the result set at maxResults', async () => {
      const many = pathIn('many')
      mkdirSync(many, { recursive: true })
      for (let i = 0; i < 20; i += 1) writeFileSync(join(many, `note-${i}.txt`), 'x', 'utf-8')

      const entries = (await payload('/api/fs/search-files', {
        path: many,
        query: 'note',
        options: { maxResults: 5 },
      })) as SearchEntry[]

      expect(entries).toHaveLength(5)
    })

    it('caps the empty-query listing too', async () => {
      const entries = (await payload('/api/fs/search-files', {
        path: root,
        query: '',
        options: { maxResults: 2 },
      })) as SearchEntry[]

      expect(entries).toHaveLength(2)
    })

    it('stops descending past its depth budget', async () => {
      let cursor = root
      for (let level = 0; level < 12; level += 1) {
        cursor = join(cursor, `l${level}`)
      }
      mkdirSync(cursor, { recursive: true })
      writeFileSync(join(cursor, 'unreachable-hit.txt'), 'too deep', 'utf-8')

      const entries = (await payload('/api/fs/search-files', { path: root, query: 'unreachable' })) as SearchEntry[]

      expect(entries).toEqual([])
    })

    it('keeps working results from a shallower tree in the same scan', async () => {
      const entries = (await payload('/api/fs/search-files', { path: root, query: 'deepest' })) as SearchEntry[]

      expect(entries.map((e) => e.name)).toEqual(['deepest.ts'])
    })

    it('stops descending into a fresh subtree once the cap is full', async () => {
      const box = pathIn('notebox')
      mkdirSync(box, { recursive: true })
      for (let i = 0; i < 3; i += 1) writeFileSync(join(box, `note-${i}.txt`), 'x', 'utf-8')

      const entries = (await payload('/api/fs/search-files', {
        path: root,
        query: 'note',
        options: { maxResults: 1 },
      })) as SearchEntry[]

      expect(entries.map((e) => e.name)).toEqual(['notebox'])
    })

    it('logs and answers an empty list when a blank query hits a missing root', async () => {
      const entries = await payload('/api/fs/search-files', { path: pathIn('ghost'), query: '' })

      expect(entries).toEqual([])
      expect(loggerStub.warn).toHaveBeenCalledWith('H5Server', expect.stringContaining('searchFiles failed'))
    })

    it('answers an empty list for a directory that does not exist', async () => {
      expect(await payload('/api/fs/search-files', { path: pathIn('ghost'), query: 'x' })).toEqual([])
    })

    it('answers an empty list when the root is a file', async () => {
      expect(await payload('/api/fs/search-files', { path: pathIn('alpha.txt'), query: 'alpha' })).toEqual([])
    })

    it('answers an empty list when no path is supplied', async () => {
      expect(await payload('/api/fs/search-files', { query: 'alpha' })).toEqual([])
    })

    it('searches everything below the root when the query is blank and the listing is asked for', async () => {
      const entries = (await payload('/api/fs/search-files', {
        path: pathIn('empty'),
        query: '',
      })) as SearchEntry[]

      expect(entries).toEqual([])
    })
  })

  describe('route shape', () => {
    it('still requires a valid token before touching the filesystem', async () => {
      const res = await rawRequest({
        port,
        path: '/api/fs/read-file',
        method: 'POST',
        body: { path: pathIn('alpha.txt') },
      })

      expect(res.status).toBe(401)
      expect(res.body).toBe(JSON.stringify({ error: 'Unauthorized' }))
    })

    it('answers 200 with null rather than 4xx for a bad file request', async () => {
      const res = await fsCall('/api/fs/read-file', { path: pathIn('ghost.txt') })

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    })
  })
})
