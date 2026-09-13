#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — пакует расширение в архив для установки в браузер.

    python build.py

Пишем архив вручную через zipfile, а не Compress-Archive из PowerShell:
последний в некоторых версиях кладёт в записи обратные слэши, из-за чего
браузер не находит файлы внутри архива. Пути здесь всегда с прямыми слэшами,
время фиксировано — сборка одного и того же исходника даёт одинаковый файл.
"""

import json
import os
import sys
import zipfile

# Консоль Windows по умолчанию в cp1251, а печатать приходится и кириллицу,
# и название расширения со стрелкой «→».
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, "dist")

# Firefox поддерживает это расширение? От этого зависит, собирать ли .xpi.
FIREFOX = False

# В архив идёт только само расширение: файлы репозитория браузеру не нужны, а
# магазин на посторонние файлы ругается.
#
# Список задан перечислением, а не «всё, кроме известного мусора»: при обратном
# подходе в архив уезжало всё, что просто лежит рядом в рабочей папке, — и
# заметить это можно было только по размеру архива. Так, папки docs/ (страница
# политики конфиденциальности) и store/ (тексты заявки) появились позже сборки и
# при чёрном списке молча попали бы в архив. Цена — добавляя расширению новый
# файл, его нужно вписать сюда же.
INCLUDE_FILES = {
    "manifest.json", "background.js", "content.js",
    "offscreen.html", "offscreen.js", "popup.html", "popup.js",
}
INCLUDE_DIRS = {"icons"}

# Внутри включённых папок всё равно может завестись мусор от системы и редакторов.
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
SKIP_EXT = {".pem", ".crx", ".zip", ".xpi", ".log", ".bak", ".md"}

# Дата внутри архива фиксирована, иначе одинаковый исходник давал бы разные
# файлы при каждой сборке (в ZIP пишется время модификации).
FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def skipped(name):
    return name in SKIP_NAMES or os.path.splitext(name)[1].lower() in SKIP_EXT


def collect():
    files = []
    for name in sorted(os.listdir(ROOT)):
        full = os.path.join(ROOT, name)
        if os.path.isdir(full):
            if name not in INCLUDE_DIRS:
                continue
            for dirpath, _dirnames, filenames in os.walk(full):
                for fname in sorted(filenames):
                    if skipped(fname):
                        continue
                    f = os.path.join(dirpath, fname)
                    files.append((f, os.path.relpath(f, ROOT).replace(os.sep, "/")))
        elif name in INCLUDE_FILES and not skipped(name):
            files.append((full, name))
    return sorted(files, key=lambda t: t[1])


def main():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest.get("version", "0.0.0")

    files = collect()
    if not any(rel == "manifest.json" for _, rel in files):
        print("[ОШИБКА] manifest.json не попал в архив")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    base = "suno-rpc-extension-" + version
    zip_path = os.path.join(OUT_DIR, base + ".zip")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            info = zipfile.ZipInfo(rel, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read())

    size = os.path.getsize(zip_path) / 1024
    print("Собрано «%s» v%s, файлов: %d" % (manifest.get("name", base), version, len(files)))
    for _, rel in files:
        print("   ", rel)
    print("")
    print("  dist/%s.zip  (%.1f КБ)  — Chrome / Edge / Яндекс / Opera" % (base, size))

    if FIREFOX:
        # .xpi — тот же ZIP под другим именем, отдельная сборка не нужна.
        xpi_path = os.path.join(OUT_DIR, base + ".xpi")
        with open(zip_path, "rb") as fr, open(xpi_path, "wb") as fw:
            fw.write(fr.read())
        print("  dist/%s.xpi  (%.1f КБ)  — Firefox" % (base, size))

    return 0


if __name__ == "__main__":
    sys.exit(main())
