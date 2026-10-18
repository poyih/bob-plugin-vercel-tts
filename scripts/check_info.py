#!/usr/bin/env python3
"""校验 src/info.json：字段格式、菜单默认值在菜单里、选项 identifier 与 JS 里读取的一致、
内置模型菜单全部能被 config.getModelFamily 识别为已知家族。

用法：python3 scripts/check_info.py（make lint 会自动跑）
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"


def main() -> int:
    info = json.loads((SRC / "info.json").read_text(encoding="utf-8"))
    problems: list[str] = []

    for field in ("identifier", "version", "category", "name", "options"):
        if field not in info:
            problems.append(f"缺少必填字段 {field}")
    if not re.fullmatch(r"[a-z0-9.]+", str(info.get("identifier", ""))):
        problems.append("identifier 只能由小写字母、数字和 . 组成")
    if not re.fullmatch(r"[a-z0-9.]+", str(info.get("version", ""))):
        problems.append("version 只能由小写字母、数字和 . 组成")
    if info.get("category") != "tts":
        problems.append("category 必须是 tts")
    icon = info.get("icon")
    if icon and not (SRC / icon).is_file():
        problems.append(f"icon {icon} 不存在于 src/")

    options = info.get("options", [])
    ids = [o.get("identifier", "") for o in options]
    if len(ids) != len(set(ids)):
        problems.append("options 里有重复的 identifier")

    model_values: list[str] = []
    for option in options:
        ident = option.get("identifier", "?")
        for field in ("identifier", "type", "title"):
            if field not in option:
                problems.append(f"{ident}: 缺少 {field}")
        kind = option.get("type")
        if kind == "menu":
            values = [m.get("value") for m in option.get("menuValues", [])]
            if ident == "model":
                model_values = [v for v in values if isinstance(v, str)]
            if not values:
                problems.append(f"{ident}: menu 没有 menuValues")
            if len(values) != len(set(values)):
                problems.append(f"{ident}: 菜单值重复")
            if option.get("defaultValue") not in values:
                problems.append(f"{ident}: defaultValue {option.get('defaultValue')!r} 不在菜单里")
            for item in option.get("menuValues", []):
                if not isinstance(item.get("value"), str) or "title" not in item:
                    problems.append(f"{ident}: 菜单项必须有字符串 value 和 title")
        elif kind == "text":
            if "defaultValue" not in option:
                problems.append(f"{ident}: text 选项缺少 defaultValue（Bob 会把它显示成空）")
            text_type = (option.get("textConfig") or {}).get("type")
            if text_type not in (None, "secure", "visible"):
                problems.append(f"{ident}: textConfig.type 只能是 secure / visible")
        else:
            problems.append(f"{ident}: 未知类型 {kind!r}")

    js = (SRC / "main.js").read_text(encoding="utf-8") + (SRC / "config.js").read_text(encoding="utf-8")
    used = set(re.findall(r'readOption\("([A-Za-z0-9_]+)"\)', js))
    used |= set(re.findall(r'voiceOption:\s*"([A-Za-z0-9_]+)"', js))
    for name in sorted(used - set(ids)):
        problems.append(f"JS 读取了 info.json 里不存在的选项 {name}")
    for name in sorted(set(ids) - used):
        problems.append(f"info.json 的选项 {name} 在 JS 里从未被读取")

    if model_values and Path(JSC).is_file():
        expr = (
            "globalThis.exports={}; load('src/config.js'); var c=globalThis.exports; "
            f"var ms={json.dumps(model_values)}; "
            "for (var i=0;i<ms.length;i++){ var f=c.getModelFamily(ms[i]); if (f==='custom') print(ms[i]); }"
        )
        out = subprocess.check_output([JSC, "-e", expr], cwd=ROOT, text=True).strip()
        for unknown in [line for line in out.splitlines() if line.strip()]:
            problems.append(f"model 菜单里的 {unknown} 未在 src/config.js 中配置家族（被归入 custom）")

    if problems:
        for line in problems:
            print("info FAIL  " + line)
        return 1
    print(f"info ok    src/info.json ({len(ids)} options, {len(model_values)} models)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
