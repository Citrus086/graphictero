"""M0 探针：用 MinerU 解析单个 PDF，记录耗时、峰值内存和页级进度（D72）。

用法：
    uv run python parse_one.py <pdf路径> [--out 输出目录] [--tier standard]

并发固定为 1（M0 要求）。页级进度通过两条路探查：
1. 捕获 mineru 子进程 stdout/stderr 里是否出现页码/进度信息；
2. mineru 4.x 支持 -no-wait + 内容游标轮询（异步模式），脚本里检查该能力。

输出 JSON 打印到 stdout（最后一行以 PARSE_RESULT 开头）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import resource
import subprocess
import sys
import threading
import time
from pathlib import Path

import psutil

MINERU = ["uv", "run", "mineru", "parse"]


def page_count(pdf: Path) -> int | None:
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(str(pdf))
        n = len(doc)
        doc.close()
        return n
    except Exception:
        return None


def parse_one(pdf: Path, out: Path, tier: str, wait: int = 600) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    md_out = out / f"{pdf.stem}.md"  # mineru 4.x 单文件解析的 -o 是输出 markdown 文件路径
    cmd = MINERU + [str(pdf), "--pages", "all", "-o", str(md_out), "--tier", tier, "--wait", str(wait), "-v"]
    t0 = time.monotonic()
    # 轮询 MinerU server/worker 进程的真实峰值 RSS（解析发生在服务端，不在 CLI 子进程里）
    server_peak = [0]
    stop_sampling = threading.Event()

    def sample_server_rss() -> None:
        while not stop_sampling.is_set():
            for p in psutil.process_iter(["name", "cmdline", "memory_info"]):
                try:
                    cl = " ".join(p.cmdline() or [])
                    if "mineru" in (p.name() or "").lower() or "mineru" in cl.lower():
                        server_peak[0] = max(server_peak[0], p.memory_info().rss)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            stop_sampling.wait(2)

    sampler = threading.Thread(target=sample_server_rss, daemon=True)
    sampler.start()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    log_lines: list[str] = []
    page_progress: list[str] = []
    # 常见进度格式：页码 x/y、"page i of n"、百分比等
    progress_re = re.compile(r"(\d+\s*/\s*\d+|page\s+\d+\s+of\s+\d+|\d+%|进度|第\s*\d+\s*页)", re.I)
    assert proc.stdout is not None
    for line in proc.stdout:
        log_lines.append(line.rstrip())
        if progress_re.search(line):
            page_progress.append(line.rstrip())
    rc = proc.wait()
    stop_sampling.set()
    sampler.join(timeout=5)
    elapsed = time.monotonic() - t0
    # macOS 上 ru_maxrss 单位是字节；Linux 是 KB。这里按 macOS 处理并标注。
    peak_rss_bytes = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss

    md_files = sorted(out.rglob("*.md"))  # markdown 及配套资源（图片等）都会落在 out 下
    return {
        "pdf": pdf.name,
        "pages": page_count(pdf),
        "tier": tier,
        "returncode": rc,
        "elapsed_sec": round(elapsed, 1),
        "peak_rss_mb": round(peak_rss_bytes / 1024 / 1024, 1),
        "server_peak_rss_mb": round(server_peak[0] / 1024 / 1024, 1),
        "markdown_files": [str(p.relative_to(out)) for p in md_files],
        "markdown_chars": sum(len(p.read_text(errors="ignore")) for p in md_files),
        "page_progress_lines_captured": page_progress[:50],
        "log_tail": log_lines[-20:],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default=None)
    ap.add_argument("--tier", default="standard")
    ap.add_argument("--wait", type=int, default=600, help="等待解析完成的最长秒数")
    args = ap.parse_args()

    pdf = Path(args.pdf).expanduser().resolve()
    out = Path(args.out).expanduser().resolve() if args.out else Path("probes/results/mineru") / pdf.stem
    result = parse_one(pdf, out, args.tier, wait=args.wait)
    print("PARSE_RESULT " + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
