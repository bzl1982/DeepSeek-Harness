#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为 dsh-client-ui-theme 设置面板「外观」区追加「字体颜色」二选一（蓝色字体 / 黑色字体）。

直接修改 React 组件源码（AppearanceRow），选项作为原生渲染内容，
不会被 React 重渲染清除。幂等：已打过补丁（含 [dsh-font-skin] 标志）则跳过。

用法: python3 scripts/patch-dsh-theme.py <dsh-client-ui-theme/lib/client.js 路径>
"""
import io
import sys


def patch(path):
    with io.open(path, "r", encoding="utf-8") as f:
        src = f.read()

    if "[dsh-font-skin]" in src:
        print(f"[patch-dsh-theme] 已打过补丁，跳过: {path}")
        return True

    # 1) 引入 react（useState）
    a1 = 'let react_jsx_runtime = require("react/jsx-runtime");'
    assert a1 in src, "锚点1缺失"
    src = src.replace(a1, a1 + '\n\t\tlet react = require("react");', 1)

    # 2) CSS modules 映射追加新类
    a2 = '\t\t\t"cubeRow": "_8HJdBW_cubeRow",\n\t\t\t"group": "_8HJdBW_group",\n\t\t\t"selected": "_8HJdBW_selected",\n\t\t\t"themeCube": "_8HJdBW_themeCube",\n\t\t\t"title": "_8HJdBW_title"'
    assert a2 in src, "锚点2缺失"
    src = src.replace(
        a2,
        a2
        + ',\n\t\t\t"fontRow": "_8HJdBW_fontRow",\n\t\t\t"fontTitle": "_8HJdBW_fontTitle",\n\t\t\t"fontBtns": "_8HJdBW_fontBtns",\n\t\t\t"fontBtn": "_8HJdBW_fontBtn",\n\t\t\t"fontSelected": "_8HJdBW_fontSelected"',
        1,
    )

    # 3) CSS 文本追加字体颜色行样式
    a3 = '._8HJdBW_selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}"'
    assert a3 in src, "锚点3缺失"
    extra = (
        "._8HJdBW_fontRow{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}"
        "._8HJdBW_fontTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}"
        "._8HJdBW_fontBtns{flex-wrap:wrap;gap:8px;display:flex}"
        "._8HJdBW_fontBtn{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:20px;justify-content:center;align-items:center;gap:4px;padding:8px 24px;font-size:14px;line-height:22px;display:flex}"
        "._8HJdBW_fontBtn:hover:not(._8HJdBW_fontSelected){background:var(--dsw-alias-interactive-bg-hover)}"
        "._8HJdBW_fontSelected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}"
    )
    src = src.replace(a3, a3[:-1] + extra + '"', 1)

    # 4) AppearanceRow：helpers + useState
    a4 = "\t\tfunction AppearanceRow({ t, setTheme, useStore }) {\n\t\t\tconst preference = useStore((s) => s.preference);"
    assert a4 in src, "锚点4缺失"
    helpers = (
        '\t\t/** [dsh-font-skin] 桌面版「字体颜色」偏好（蓝色字体 = 品牌蓝鲸主题，黑色字体 = 官方原生）。 */\n'
        '\t\tfunction getFontSkin() {\n'
        '\t\t\ttry { return localStorage.getItem("dsh-desktop-skin") || "blue"; } catch (e) { return "blue"; }\n'
        "\t\t}\n"
        "\t\tfunction setFontSkin(id) {\n"
        '\t\t\ttry { localStorage.setItem("dsh-desktop-skin", id); } catch (e) {}\n'
        '\t\t\tif (id === "blue") { document.documentElement.setAttribute("data-ds-skin", "blue"); }\n'
        '\t\t\telse { document.documentElement.removeAttribute("data-ds-skin"); }\n'
        "\t\t}\n"
        "\t\tconst FONT_OPTIONS = [\n"
        '\t\t\t{ id: "blue", label: "蓝色字体" },\n'
        '\t\t\t{ id: "black", label: "黑色字体" }\n'
        "\t\t];\n"
        "\t\tfunction AppearanceRow({ t, setTheme, useStore }) {\n"
        "\t\t\tconst preference = useStore((s) => s.preference);\n"
        "\t\t\tconst [fontSkin, setFontSkinState] = react.useState(getFontSkin);"
    )
    src = src.replace(a4, helpers, 1)

    # 5) cubeRow 之后追加字体颜色行
    a5 = (
        "\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(Icon, {}), t(labelKey)]\n"
        "\t\t\t\t\t}, id))\n"
        "\t\t\t\t})]\n"
        "\t\t\t});\n"
        "\t\t}"
    )
    assert a5 in src, "锚点5缺失"
    fontrow = (
        "\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(Icon, {}), t(labelKey)]\n"
        "\t\t\t\t\t}, id))\n"
        "\t\t\t\t}), (0, react_jsx_runtime.jsxs)(\"div\", {\n"
        "\t\t\t\t\tclassName: AppearanceRow_module_css_default.fontRow,\n"
        "\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"div\", {\n"
        "\t\t\t\t\t\tclassName: AppearanceRow_module_css_default.fontTitle,\n"
        '\t\t\t\t\t\tchildren: "字体颜色"\n'
        "\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(\"div\", {\n"
        "\t\t\t\t\t\tclassName: AppearanceRow_module_css_default.fontBtns,\n"
        "\t\t\t\t\t\tchildren: FONT_OPTIONS.map(({ id, label }) => (0, react_jsx_runtime.jsxs)(\"button\", {\n"
        "\t\t\t\t\t\t\ttype: \"button\",\n"
        "\t\t\t\t\t\t\tclassName: clsx(AppearanceRow_module_css_default.fontBtn, fontSkin === id && AppearanceRow_module_css_default.fontSelected),\n"
        "\t\t\t\t\t\t\t\"aria-pressed\": fontSkin === id,\n"
        "\t\t\t\t\t\t\tonClick: () => {\n"
        "\t\t\t\t\t\t\t\tsetFontSkin(id);\n"
        "\t\t\t\t\t\t\t\tsetFontSkinState(id);\n"
        "\t\t\t\t\t\t\t},\n"
        "\t\t\t\t\t\t\tchildren: [label]\n"
        "\t\t\t\t\t\t}, id))\n"
        "\t\t\t\t\t})]\n"
        "\t\t\t\t})]\n"
        "\t\t\t});\n"
        "\t\t}"
    )
    src = src.replace(a5, fontrow, 1)

    with io.open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print(f"[patch-dsh-theme] 补丁已写入: {path}")
    return True


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: python3 scripts/patch-dsh-theme.py <client.js 路径>")
        sys.exit(1)
    patch(sys.argv[1])
