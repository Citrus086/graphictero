import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 读仓库根目录 .env（D34：Key 只放 .env，不提交）。返回对象，不含注释行。 */
export function loadEnv(path = resolve(process.cwd(), '.env')) {
  const env = {}
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* .env 不存在时返回空对象，由调用方决定报错还是无 key 运行 */
  }
  return env
}
