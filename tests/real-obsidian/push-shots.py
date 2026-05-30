#!/usr/bin/env python3
"""把真机 E2E 截图推到企微订单日报群。用法: python3 push-shots.py <run_dir>"""
import base64
import hashlib
import os
import sys
import time
from pathlib import Path

import requests

# 企微 webhook 从环境变量读，避免把 key 写进公开仓库。
#   export WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>"
# 内部用的就是订单日报群那个 key（同 lzycronjobs/jobs/obsidian_daily_report.py）。
WEBHOOK = os.environ.get("WECOM_WEBHOOK", "")
if not WEBHOOK:
    sys.exit("请先 export WECOM_WEBHOOK=<企微webhook>")

INTRO = (
    "[插件加速商店 · 真机 E2E]\n"
    "真 Obsidian 装本插件「插件加速商店」(plugin-market-cn)：\n"
    "① 打开商店 → 线上 relay-1 拉到 4282 个官方插件（按下载量排序，弃用插件带标记）\n"
    "② 搜索 dataview\n"
    "③ 一键安装 → 走线上 relay-1 /gh 下载链路 → Dataview v0.5.68 安装成功\n"
    "下面 3 张截图：商店列表 / dataview 卡片 / 安装成功(重新安装态+成功提示)"
)

SHOTS = ["shot-01-store.png", "shot-02-dataview-card.png", "shot-03-installed.png"]


def send_text(content):
    r = requests.post(WEBHOOK, json={"msgtype": "text", "text": {"content": content}}, timeout=20)
    print("text ->", r.status_code, r.json().get("errmsg"))


def send_image(path: Path):
    raw = path.read_bytes()
    r = requests.post(
        WEBHOOK,
        json={
            "msgtype": "image",
            "image": {
                "base64": base64.b64encode(raw).decode(),
                "md5": hashlib.md5(raw).hexdigest(),
            },
        },
        timeout=20,
    )
    print(f"image {path.name} ({len(raw)}B) ->", r.status_code, r.json().get("errmsg"))


def main():
    run_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    send_text(INTRO)
    time.sleep(1)
    for name in SHOTS:
        p = run_dir / name
        if not p.exists():
            print("missing", p)
            continue
        send_image(p)
        time.sleep(1)


if __name__ == "__main__":
    main()
