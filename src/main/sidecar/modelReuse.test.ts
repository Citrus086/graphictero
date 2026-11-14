import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STANDARD_TIER_MODEL_DIRS,
  assertNotRealMineruInTest,
  hasReusableModels,
  hasTierModels,
  listFileEntries,
  plainCopyDiskWarning,
  reuseModels,
  type CloneExec
} from './modelReuse'

/**
 * D145/D190 模型复用单测：全部在临时目录里用小假模型目录——绝不读写真实 ~/.mineru。
 * 克隆成败由可注入的 `cp -c` 执行器决定（退出码），不靠会抛错的 copyFile。
 */

let dir: string
let globalModels: string
let mineruHome: string

/** 造一个假的本档模型源目录（standard 档两个子目录，各几个小文件） */
function makeFakeModels(root: string): void {
  for (const sub of STANDARD_TIER_MODEL_DIRS) {
    mkdirSync(join(root, sub, 'nested'), { recursive: true })
    writeFileSync(join(root, sub, 'a.bin'), Buffer.alloc(4096, 1))
    writeFileSync(join(root, sub, 'nested', 'b.bin'), Buffer.alloc(2048, 2))
  }
}

function snapshotEntries(root: string): Record<string, number> {
  return Object.fromEntries(listFileEntries(root))
}

/** 目录 + 每个文件的 mtime（证明复用不改源） */
function snapshotMtime(root: string): Record<string, number> {
  const out: Record<string, number> = { '.': statSync(root).mtimeMs }
  const walk = (cur: string, base: string): void => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name)
      const rel = base ? `${base}/${name}` : name
      const st = statSync(full)
      out[rel] = st.mtimeMs
      if (st.isDirectory()) walk(full, rel)
    }
  }
  walk(root, '')
  return out
}

/** 测试里模拟「cp -c 成功」：自己把文件放到目标，并记录参数组。 */
function cloneSucceeds(seen: string[][]): CloneExec {
  return (args) => {
    seen.push([...args])
    const src = args[2]
    const dest = args[3]
    const copyDir = (s: string, d: string): void => {
      mkdirSync(d, { recursive: true })
      for (const name of readdirSync(s)) {
        const sp = join(s, name)
        const dp = join(d, name)
        const st = statSync(sp)
        if (st.isDirectory()) copyDir(sp, dp)
        else if (st.isFile()) copyFileSync(sp, dp)
      }
    }
    if (src && dest) copyDir(src, dest)
    return 0
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gt-modelreuse-'))
  globalModels = join(dir, 'global', 'models')
  mineruHome = join(dir, 'mineru-home')
  mkdirSync(globalModels, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('modelReuse.hasReusableModels / hasTierModels（D145）', () => {
  it('两个标准档目录都在且非空才算就绪；缺一个就不算', () => {
    expect(hasReusableModels(globalModels)).toBe(false)
    expect(hasTierModels(globalModels)).toBe(false)
    makeFakeModels(globalModels)
    expect(hasReusableModels(globalModels)).toBe(true)
    expect(hasTierModels(globalModels)).toBe(true)
    rmSync(join(globalModels, STANDARD_TIER_MODEL_DIRS[1]), { recursive: true })
    expect(hasReusableModels(globalModels)).toBe(false)
    expect(hasTierModels(globalModels)).toBe(false)
    expect(hasTierModels(join(dir, 'nope'))).toBe(false)
  })

  it('空目录、只有一个档目录、只有杂文件、空的档目录都不算就绪', () => {
    mkdirSync(globalModels, { recursive: true })
    expect(hasTierModels(globalModels)).toBe(false)

    mkdirSync(join(globalModels, STANDARD_TIER_MODEL_DIRS[0]), { recursive: true })
    writeFileSync(join(globalModels, STANDARD_TIER_MODEL_DIRS[0], 'only-one.bin'), 'x')
    expect(hasTierModels(globalModels)).toBe(false)

    rmSync(globalModels, { recursive: true })
    mkdirSync(globalModels, { recursive: true })
    writeFileSync(join(globalModels, 'readme.txt'), 'junk')
    expect(hasTierModels(globalModels)).toBe(false)

    rmSync(globalModels, { recursive: true })
    for (const sub of STANDARD_TIER_MODEL_DIRS) mkdirSync(join(globalModels, sub), { recursive: true })
    expect(hasTierModels(globalModels)).toBe(false)
  })
})

describe('modelReuse 克隆执行器（D190：cp -c 退出码，不靠 copyFile 抛错）', () => {
  it('克隆命令成功（退出码 0）→ cloned=true，且不退回普通复制', async () => {
    makeFakeModels(globalModels)
    const seen: string[][] = []
    const result = await reuseModels(globalModels, mineruHome, undefined, {
      cloneExec: cloneSucceeds(seen),
      copyFile: () => {
        throw new Error('克隆已成功，不应退回普通复制')
      }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.slice(0, 2)).toEqual(['-c', '-R'])
    expect(result.cloned).toBe(true)
    expect(result.files).toBe(4)
    expect(snapshotEntries(join(mineruHome, 'models'))).toEqual(snapshotEntries(globalModels))
  })

  it('克隆命令失败（退出码非 0）→ 退回普通复制、cloned=false，文案写明约占额外磁盘', async () => {
    makeFakeModels(globalModels)
    const seen: string[][] = []
    const logs: string[] = []
    const progress: string[] = []
    const result = await reuseModels(globalModels, mineruHome, (m) => logs.push(m), {
      cloneExec: (args) => {
        seen.push([...args])
        return 1
      },
      onProgress: (msg) => {
        progress.push(msg)
      }
    })
    expect(seen[0]?.slice(0, 2)).toEqual(['-c', '-R'])
    expect(result.cloned).toBe(false)
    expect(result.files).toBe(4)
    expect(snapshotEntries(join(mineruHome, 'models'))).toEqual(snapshotEntries(globalModels))
    const warn = plainCopyDiskWarning(result.bytes)
    expect(warn).toMatch(/^无法克隆，已普通复制，约占 \d+(\.\d+)? (KB|MB|GB) 额外磁盘$/)
    expect(logs.join('\n')).toContain(warn)
    expect(progress.some((m) => m.includes('无法克隆'))).toBe(true)
    expect(progress.length).toBeGreaterThanOrEqual(2)
  })

  it('非 darwin 不跑克隆命令，直接普通复制且 cloned=false', async () => {
    makeFakeModels(globalModels)
    const result = await reuseModels(globalModels, mineruHome, undefined, { platform: 'linux' })
    expect(result.cloned).toBe(false)
    expect(result.files).toBe(4)
    expect(snapshotEntries(join(mineruHome, 'models'))).toEqual(snapshotEntries(globalModels))
  })
})

describe('modelReuse.reuseModels（D145：原子改名 + 校验 + 不触碰源目录）', () => {
  it('复制到临时目录 → 校验 → 原子改名：models 存在、临时目录已清、源目录逐字节不变', async () => {
    makeFakeModels(globalModels)
    const before = snapshotEntries(globalModels)
    const mtimeBefore = snapshotMtime(globalModels)
    const result = await reuseModels(globalModels, mineruHome, undefined, { platform: 'linux' })
    expect(existsSync(join(mineruHome, 'models'))).toBe(true)
    expect(existsSync(join(mineruHome, '.models-reuse-tmp'))).toBe(false)
    expect(result.files).toBe(4)
    expect(snapshotEntries(join(mineruHome, 'models'))).toEqual(before)
    expect(snapshotEntries(globalModels)).toEqual(before)
    expect(snapshotMtime(globalModels)).toEqual(mtimeBefore)
    for (const rel of Object.keys(before)) {
      expect(readFileSync(join(mineruHome, 'models', rel))).toEqual(readFileSync(join(globalModels, rel)))
    }
  })

  it('目标已有完整本档模型 → 拒绝覆盖', async () => {
    makeFakeModels(globalModels)
    makeFakeModels(join(mineruHome, 'models'))
    await expect(reuseModels(globalModels, mineruHome)).rejects.toThrow('拒绝覆盖')
    expect(existsSync(join(mineruHome, 'models.incomplete-'))).toBe(false)
  })

  it('空目录、只有一个档、只有杂文件：挪成 models.incomplete-* 后再复用，源目录不动', async () => {
    makeFakeModels(globalModels)
    const mtimeBefore = snapshotMtime(globalModels)
    const cases: Array<(root: string) => void> = [
      (root) => mkdirSync(root, { recursive: true }),
      (root) => {
        mkdirSync(join(root, STANDARD_TIER_MODEL_DIRS[0]), { recursive: true })
        writeFileSync(join(root, STANDARD_TIER_MODEL_DIRS[0], 'half.bin'), 'half')
      },
      (root) => {
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, 'junk.txt'), 'junk')
      }
    ]
    for (const setup of cases) {
      rmSync(mineruHome, { recursive: true, force: true })
      setup(join(mineruHome, 'models'))
      const result = await reuseModels(globalModels, mineruHome, undefined, { platform: 'linux' })
      expect(result.quarantined).toBeTruthy()
      expect(result.quarantined?.startsWith(mineruHome)).toBe(true)
      expect(result.quarantined).toContain('models.incomplete-')
      expect(existsSync(result.quarantined as string)).toBe(true)
      expect(hasTierModels(join(mineruHome, 'models'))).toBe(true)
      expect(snapshotMtime(globalModels)).toEqual(mtimeBefore)
    }
  })

  it('复制中途失败（源里有读不了的文件）→ 抛错、无 models、无临时残留，修复源后可整体重试成功', async () => {
    makeFakeModels(globalModels)
    const blocked = join(globalModels, STANDARD_TIER_MODEL_DIRS[0], 'blocked.bin')
    writeFileSync(blocked, Buffer.alloc(64))
    chmodSync(blocked, 0o000)
    try {
      await expect(reuseModels(globalModels, mineruHome, undefined, { platform: 'linux' })).rejects.toThrow()
    } finally {
      chmodSync(blocked, 0o644)
    }
    expect(existsSync(join(mineruHome, 'models'))).toBe(false)
    expect(existsSync(join(mineruHome, '.models-reuse-tmp'))).toBe(false)
    const result = await reuseModels(globalModels, mineruHome, undefined, { platform: 'linux' })
    expect(result.files).toBe(5)
    expect(existsSync(join(mineruHome, 'models'))).toBe(true)
  })

  it('上一次的临时残留（中断）会被清掉再重来', async () => {
    makeFakeModels(globalModels)
    mkdirSync(join(mineruHome, '.models-reuse-tmp', 'junk'), { recursive: true })
    writeFileSync(join(mineruHome, '.models-reuse-tmp', 'junk', 'x.bin'), 'x')
    const result = await reuseModels(globalModels, mineruHome, undefined, { platform: 'linux' })
    expect(result.files).toBe(4)
    expect(existsSync(join(mineruHome, '.models-reuse-tmp'))).toBe(false)
  })
})

describe('D145 红线：测试不得碰到真实 ~/.mineru', () => {
  it('词法路径落在真实 ~/.mineru 时直接拒绝，不 stat 该目录', async () => {
    const real = join(homedir(), '.mineru', 'models')
    expect(() => assertNotRealMineruInTest(real)).toThrow('测试拒绝访问')
    expect(() => hasReusableModels(real)).toThrow('测试拒绝访问')
    await expect(reuseModels(real, mineruHome)).rejects.toThrow('测试拒绝访问')
    expect(existsSync(join(mineruHome, 'models'))).toBe(false)
  })
})

describe('真实 cp -c（只碰本测试的临时目录）', () => {
  it.skipIf(process.platform !== 'darwin')('同卷临时目录上 cp -c 退出码 0 → cloned=true', async () => {
    makeFakeModels(globalModels)
    const probe = spawnSync('cp', ['-c', '-R', globalModels, join(dir, 'probe-dst')], { encoding: 'utf8' })
    expect(probe.status).toBe(0)
    rmSync(join(dir, 'probe-dst'), { recursive: true, force: true })
    const result = await reuseModels(globalModels, mineruHome)
    expect(result.files).toBe(4)
    expect(result.cloned).toBe(true)
    expect(readdirSync(globalModels).sort()).toEqual([...STANDARD_TIER_MODEL_DIRS].sort())
  })
})
