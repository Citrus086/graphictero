# MinerU sidecar（M0 探针）

Graphictero 的 PDF 解析 sidecar（D17、D21、D57、D72）。

- 版本锁定：`uv.lock`（D72），不自动升级；升级要改 `pyproject.toml` 里的约束并重新 `uv lock`。
- 运行环境：本机 macOS（M3 Pro / 18GB），纯 CPU 推理。
- 并发：1（M0 探针要求）。

## 用法

```bash
cd sidecar/mineru
uv sync                       # 按 uv.lock 装依赖
uv run python parse_one.py <pdf> [--out DIR]
uv run python parse_batch.py  # 解析 ../.. /probes/fixtures/pdfs 下全部 PDF，并发 1
```

脚本会记录每篇耗时、峰值内存（RUSAGE_CHILDREN 的 ru_maxrss）、输出文件大小，
结果写到 `probes/results/mineru-batch.json`。
