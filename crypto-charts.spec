# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — CryptoCharts desktop exe."""

import sys
from pathlib import Path

block_cipher = None
root = Path(SPECPATH)

datas = [
    (str(root / "index.html"), "."),
    (str(root / "trading.html"), "."),
    (str(root / "css"), "css"),
    (str(root / "js"), "js"),
]

hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.main",
    "uvicorn.config",
    "uvicorn.server",
    "fastapi",
    "pydantic",
    "pydantic.deprecated.decorator",
    "bot",
    "bot.server",
    "bot.config",
    "bot.exchange",
    "bot.strategy",
    "bot.indicators",
    "bot.risk",
    "bot.swing_levels",
    "bot.bot",
    "dotenv",
    "requests",
    "starlette.routing",
    "starlette.responses",
    "starlette.middleware",
    "starlette.middleware.cors",
    "anyio",
    "anyio._backends._asyncio",
]

a = Analysis(
    [str(root / "launch.py")],
    pathex=[str(root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="CryptoCharts",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
