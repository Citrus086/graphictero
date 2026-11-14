# 日常开发

默认命令是 `pnpm dev:isolated`（D146）。

它使用持久的开发数据根，和已经安装的 App 分开：

- 数据根默认是 `~/Library/Application Support/Graphictero-dev`
- 可用环境变量 `GRAPHICTERO_DEV_DATA_ROOT` 换成别的目录
- Electron 的 user-data 在数据根下的 `user-data/`
- 解析出来的数据根如果和默认 App 目录 `~/Library/Application Support/Graphictero` 是同一个路径，脚本直接报错退出

MinerU 模型跟数据根走（D145），放在 `<数据根>/sidecar/mineru-home`。开发数据根是持久的，所以不会每次启动都复制或下载模型。第一次需要模型时，如果本机 `~/.mineru/models` 里已经有同一档模型，会复制过去（APFS 上优先克隆），不会移动或删除 `~/.mineru`。

`pnpm dev` 会使用默认数据目录 `~/Library/Application Support/Graphictero`，和已安装的 App 写在一起。日常不要用。

要一块干净的一次性环境：`pnpm dev:isolated:tmp`（每次新建临时数据根和 user-data，用完即弃）。

`pnpm dev`、`pnpm dev:isolated`、`pnpm dev:isolated:tmp`、`pnpm build` 启动前都会检查 Electron dist。不完整就失败并打印怎么修。能离线修好时用 `pnpm fix:electron-dist`（只在本机缓存里的 zip 和 `checksums.json` 对得上时才解压，不联网）。
