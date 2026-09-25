#!/usr/bin/env python3
"""从 AI Gateway 的公开模型目录同步 TTS 模型菜单到 src/info.json。

GET https://ai-gateway.vercel.sh/v1/models 不需要 Key，返回全部模型；筛 type == "speech"
就是网关当前能做语音合成的模型。语音合成在网关上还是 beta，目录会变，所以做成脚本。

用法：
    make sync                 # 只补新增、删掉已下架，保留已有标题与顺序
    make sync SYNC_ARGS=--replace   # 用目录里的名称 + 价格整体重写标题
    python3 scripts/sync_models.py --dry-run

家族能力（音色菜单、默认格式、是否支持 speed 等）不在目录里，仍需手工维护 src/config.js。
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INFO_PATH = ROOT / "src" / "info.json"
CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models"


def fetch_models() -> list:
    request = urllib.request.Request(CATALOG_URL, headers={"User-Agent": "bob-plugin-vercel-tts sync"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["data"]


def price_text(model: dict) -> str:
    pricing = model.get("pricing") or {}
    per_char = pricing.get("speech_input_character_cost")
    if per_char:
        return f"${float(per_char) * 1e6:g}/百万字符"
    inp = pricing.get("input")
    out = pricing.get("audio_output_token_cost") or pricing.get("output")
    if inp and out:
        return f"输入 ${float(inp) * 1e6:g} + 音频输出 ${float(out) * 1e6:g}/百万 token"
    return ""


def title_for(model: dict) -> str:
    name = model.get("name") or model["id"]
    owner = model.get("owned_by", "")
    title = f"{name} ({owner})" if owner else name
    price = price_text(model)
    return f"{title} — {price}" if price else title


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--replace", action="store_true", help="用目录名称整体重写菜单标题与顺序")
    parser.add_argument("--dry-run", action="store_true", help="只打印变更，不写文件")
    args = parser.parse_args()

    speech = [m for m in fetch_models() if m.get("type") == "speech"]
    speech.sort(key=lambda m: (m.get("owned_by", ""), m["id"]))
    if not speech:
        print("目录里没有 type=speech 的模型，放弃同步", file=sys.stderr)
        return 1

    info = json.loads(INFO_PATH.read_text(encoding="utf-8"))
    option = next(o for o in info["options"] if o["identifier"] == "model")
    existing = {item["value"]: item for item in option["menuValues"]}
    catalog_ids = [m["id"] for m in speech]

    added = [m["id"] for m in speech if m["id"] not in existing]
    removed = [value for value in existing if value not in catalog_ids]

    if args.replace:
        menu = [{"title": title_for(m), "value": m["id"]} for m in speech]
    else:
        menu = [item for item in option["menuValues"] if item["value"] in catalog_ids]
        menu += [{"title": title_for(m), "value": m["id"]} for m in speech if m["id"] not in existing]

    values = [item["value"] for item in menu]
    default = option.get("defaultValue")
    if default not in values:
        print(f"默认模型 {default} 已不在目录里，改为 {values[0]}")
        option["defaultValue"] = values[0]

    print(f"目录 speech 模型 {len(speech)} 个：" + ", ".join(catalog_ids))
    print("新增：" + (", ".join(added) if added else "无"))
    print("下架：" + (", ".join(removed) if removed else "无"))
    if args.dry_run:
        for item in menu:
            print(f"  - {item['value']} | {item['title']}")
        return 0

    option["menuValues"] = menu
    INFO_PATH.write_text(json.dumps(info, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
    print(f"已写入 {INFO_PATH.relative_to(ROOT)}；家族能力请核对 src/config.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
