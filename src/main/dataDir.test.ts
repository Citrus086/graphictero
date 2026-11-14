import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_DIR_NAME, blockedCloudReason, defaultDataRoot, resolveDataDir } from './dataDir'

const HOME = join('/Users', 'tester')

describe('defaultDataRoot（D91）', () => {
  it('默认根位置是 ~/Library/Application Support/', () => {
    expect(defaultDataRoot(HOME)).toBe(join(HOME, 'Library', 'Application Support'))
  })
})

describe('resolveDataDir（D83）', () => {
  it('数据目录 = 根位置 + Graphictero（目录名固定）', () => {
    const r = resolveDataDir(join(HOME, 'Library', 'Application Support'), HOME)
    expect(r).toEqual({ ok: true, dir: join(HOME, 'Library', 'Application Support', APP_DIR_NAME) })
  })

  it('自定义根位置同样在其下建 Graphictero 目录', () => {
    const r = resolveDataDir('/Volumes/ExtData/graphictero-data', HOME)
    expect(r).toEqual({ ok: true, dir: join('/Volumes/ExtData/graphictero-data', APP_DIR_NAME) })
  })

  it('空路径 / 相对路径不通过', () => {
    expect(resolveDataDir('', HOME)).toEqual({ ok: false, reason: 'empty_path' })
    expect(resolveDataDir('   ', HOME)).toEqual({ ok: false, reason: 'empty_path' })
    expect(resolveDataDir('some/relative/dir', HOME)).toEqual({ ok: false, reason: 'relative_path' })
  })

  it('iCloud Drive 路径被拦下（D83）', () => {
    const icloud = join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'docs')
    expect(resolveDataDir(icloud, HOME)).toEqual({ ok: false, reason: 'icloud' })
    // 不区分大小写之外的别名：Mobile Documents 下任意子目录都算
    expect(blockedCloudReason(join(HOME, 'Library', 'Mobile Documents'), HOME)).toBe('icloud')
  })

  it('Dropbox 路径被拦下（D83）', () => {
    expect(resolveDataDir(join(HOME, 'Dropbox'), HOME)).toEqual({ ok: false, reason: 'dropbox' })
    expect(resolveDataDir(join(HOME, 'Dropbox', 'papers'), HOME)).toEqual({ ok: false, reason: 'dropbox' })
    // 评审建 4：旧版 Dropbox Business 的「Dropbox (公司名)」/「Dropbox (Personal)」同样拦（home 首层 startsWith 口径）
    expect(resolveDataDir(join(HOME, 'Dropbox (ACME)'), HOME)).toEqual({ ok: false, reason: 'dropbox' })
    expect(
      resolveDataDir(join(HOME, 'Library', 'CloudStorage', 'Dropbox-User', 'data'), HOME)
    ).toEqual({ ok: false, reason: 'dropbox' })
  })

  it('名字里带 icloud/dropbox 字样的普通路径不拦截', () => {
    expect(resolveDataDir(join(HOME, 'Documents', 'not-icloud-folder'), HOME)).toMatchObject({ ok: true })
    expect(blockedCloudReason(join(HOME, 'Downloads', 'dropbox-export'), HOME)).toBeNull()
  })

  it('OneDrive / Google Drive 同步目录被拦下（D94）', () => {
    // OneDrive：~/OneDrive*（含商业版「OneDrive - 公司名」）
    expect(resolveDataDir(join(HOME, 'OneDrive'), HOME)).toEqual({ ok: false, reason: 'onedrive' })
    expect(resolveDataDir(join(HOME, 'OneDrive - USTC'), HOME)).toEqual({ ok: false, reason: 'onedrive' })
    expect(resolveDataDir(join(HOME, 'OneDrive', 'papers'), HOME)).toEqual({ ok: false, reason: 'onedrive' })
    // Google Drive：旧版桌面端 ~/Google Drive*、Drive for desktop 挂在 CloudStorage/GoogleDrive-邮箱
    expect(resolveDataDir(join(HOME, 'Google Drive'), HOME)).toEqual({ ok: false, reason: 'googledrive' })
    expect(resolveDataDir(join(HOME, 'Google Drive - ACME'), HOME)).toEqual({ ok: false, reason: 'googledrive' })
    expect(
      resolveDataDir(join(HOME, 'Library', 'CloudStorage', 'OneDrive-peter@company.com', 'data'), HOME)
    ).toEqual({ ok: false, reason: 'onedrive' })
    expect(
      resolveDataDir(join(HOME, 'Library', 'CloudStorage', 'GoogleDrive-peter@gmail.com', 'x'), HOME)
    ).toEqual({ ok: false, reason: 'googledrive' })
    // 评审建 2：home 首层收紧为「精确名」或「名 - 公司名」后缀——自建目录不再误拦；
    // 不带空字的 googledrive-notes 本就不在「google drive」前缀内（两种写法都留了断言）
    expect(blockedCloudReason(join(HOME, 'Downloads', 'onedrive-export'), HOME)).toBeNull()
    expect(blockedCloudReason(join(HOME, 'onedrive-export'), HOME)).toBeNull() // home 首层的自建目录
    expect(blockedCloudReason(join(HOME, 'OneDriveTemp'), HOME)).toBeNull()
    expect(blockedCloudReason(join(HOME, 'googledrive-notes'), HOME)).toBeNull()
    expect(blockedCloudReason(join(HOME, 'Library', 'CloudStorage'), HOME)).toBeNull()
    // 评审建 1：Drive for desktop 非 File Provider 形态挂载在 /Volumes/GoogleDrive，同样拦（D94「一律」）
    expect(blockedCloudReason(join('/Volumes', 'GoogleDrive', '我的云端硬盘'), HOME)).toBe('googledrive')
    expect(blockedCloudReason(join('/Volumes', 'GoogleDrive'), HOME)).toBe('googledrive')
  })
})

describe('blockedCloudReason 加固（评审必须修 2）', () => {
  // 这些用例需要真实文件系统（符号链接解引用、CloudDocs 存在性检测），
  // 用一个假的 home 目录造场景
  let fakeHome: string
  const setup = () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'gt-home-'))
    return fakeHome
  }
  const teardown = () => rmSync(fakeHome, { recursive: true, force: true })

  it('符号链接绕过：指向 Dropbox 的软链被解引用后拦下', () => {
    setup()
    try {
      const dropboxReal = join(fakeHome, 'Dropbox')
      mkdirSync(dropboxReal, { recursive: true })
      const link = join(fakeHome, 'my-data-link')
      symlinkSync(dropboxReal, link)
      expect(blockedCloudReason(link, fakeHome)).toBe('dropbox')
      // Dropbox 真身是 CloudStorage 下的软链（macOS 新版 Dropbox 常见形态）
      const cloudStorage = join(fakeHome, 'Library', 'CloudStorage')
      mkdirSync(cloudStorage, { recursive: true })
      const dbx = join(cloudStorage, 'Dropbox-User')
      mkdirSync(dbx, { recursive: true })
      const link2 = join(fakeHome, 'data-via-link')
      symlinkSync(dbx, link2)
      expect(blockedCloudReason(link2, fakeHome)).toBe('dropbox')
    } finally {
      teardown()
    }
  })

  it('目标不存在的软链：解析最近存在的父目录后仍拦下', () => {
    setup()
    try {
      const dropboxReal = join(fakeHome, 'Dropbox')
      mkdirSync(dropboxReal, { recursive: true })
      const link = join(fakeHome, 'data-link')
      symlinkSync(dropboxReal, link)
      // 数据目录（link 之下）还不存在
      expect(blockedCloudReason(join(link, 'Graphictero'), fakeHome)).toBe('dropbox')
    } finally {
      teardown()
    }
  })

  it('大小写绕过：~/dropbox 与 ~/DROPBOX 同样拦下（darwin 大小写不敏感）', () => {
    // darwin 上 normCase 转小写比较；其他平台本用例不适用，直接跳过
    if (process.platform !== 'darwin') return
    expect(blockedCloudReason(join(HOME, 'dropbox'), HOME)).toBe('dropbox')
    expect(
      blockedCloudReason(join(HOME, 'LIBRARY', 'CloudStorage', 'dropbox-peter', 'x'), HOME)
    ).toBe('dropbox')
  })

  it('D94 加固：OneDrive/Google Drive 的软链绕过与大小写绕过同样拦下', () => {
    setup()
    try {
      // 符号链接绕过：指向 OneDrive / Google Drive 的软链解引用后拦下
      const oneDriveReal = join(fakeHome, 'OneDrive - USTC')
      mkdirSync(oneDriveReal, { recursive: true })
      const link = join(fakeHome, 'my-data-link')
      symlinkSync(oneDriveReal, link)
      expect(blockedCloudReason(link, fakeHome)).toBe('onedrive')
      // CloudStorage 真身 + 软链（Drive for desktop 常见形态）
      const cloudStorage = join(fakeHome, 'Library', 'CloudStorage')
      const gdrive = join(cloudStorage, 'GoogleDrive-peter@gmail.com')
      mkdirSync(gdrive, { recursive: true })
      const link2 = join(fakeHome, 'gdrive-link')
      symlinkSync(gdrive, link2)
      expect(blockedCloudReason(link2, fakeHome)).toBe('googledrive')
      // 目标不存在的软链（数据目录尚未创建）：解析最近存在的父目录后仍拦下
      expect(blockedCloudReason(join(link, 'Graphictero'), fakeHome)).toBe('onedrive')
      // 大小写绕过（darwin 大小写不敏感）
      if (process.platform === 'darwin') {
        expect(blockedCloudReason(join(fakeHome, 'ONEDRIVE - USTC'), fakeHome)).toBe('onedrive')
        expect(
          blockedCloudReason(join(fakeHome, 'LIBRARY', 'CloudStorage', 'GOOGLEDRIVE-x@y.z', 'd'), fakeHome)
        ).toBe('googledrive')
      }
    } finally {
      teardown()
    }
  })

  it('iCloud「桌面与文稿」：CloudDocs/Desktop 存在时拦 ~/Desktop 与 ~/Documents', () => {
    setup()
    try {
      const cloudDocs = join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
      mkdirSync(join(cloudDocs, 'Desktop'), { recursive: true })
      mkdirSync(join(cloudDocs, 'Documents'), { recursive: true })
      mkdirSync(join(fakeHome, 'Desktop'), { recursive: true })
      mkdirSync(join(fakeHome, 'Documents'), { recursive: true })
      expect(blockedCloudReason(join(fakeHome, 'Desktop'), fakeHome)).toBe('icloud')
      expect(blockedCloudReason(join(fakeHome, 'Documents', 'papers'), fakeHome)).toBe('icloud')
      // 只删 Desktop 子目录（Documents 还在）仍视为开启
      rmSync(join(cloudDocs, 'Desktop'), { recursive: true, force: true })
      expect(blockedCloudReason(join(fakeHome, 'Desktop'), fakeHome)).toBe('icloud')
      // 未开启桌面文稿同步（无 Desktop/Documents 子目录）时不拦
      rmSync(join(fakeHome, 'Library'), { recursive: true, force: true })
      expect(blockedCloudReason(join(fakeHome, 'Desktop'), fakeHome)).toBeNull()
      expect(blockedCloudReason(join(fakeHome, 'Documents'), fakeHome)).toBeNull()
    } finally {
      teardown()
    }
  })

  it('仅开 iCloud Drive（有 CloudDocs 容器但无 Desktop/Documents 子目录）不误拦桌面/文稿', () => {
    setup()
    try {
      mkdirSync(join(fakeHome, 'Desktop'), { recursive: true })
      mkdirSync(join(fakeHome, 'Documents'), { recursive: true })
      // CloudDocs 容器存在（iCloud Drive 用户都有），但没有桌面文稿同步的子目录
      mkdirSync(join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true })
      expect(blockedCloudReason(join(fakeHome, 'Desktop'), fakeHome)).toBeNull()
      expect(blockedCloudReason(join(fakeHome, 'Documents'), fakeHome)).toBeNull()
    } finally {
      teardown()
    }
  })

  it('resolveDataDir 对被拦路径返回拦截原因（iCloud 桌面文稿）', () => {
    setup()
    try {
      mkdirSync(join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop'), {
        recursive: true
      })
      expect(resolveDataDir(join(fakeHome, 'Desktop'), fakeHome)).toEqual({ ok: false, reason: 'icloud' })
    } finally {
      teardown()
    }
  })
})
