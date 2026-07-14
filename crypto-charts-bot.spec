# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — CryptoCharts background bot (no UI)."""

from pathlib import Path

block_cipher = None
root = Path(SPECPATH)

hiddenimports = [
    "bot",
    "bot.config",
    "bot.exchange",
    "bot.strategy",
    "bot.indicators",
    "bot.risk",
    "bot.swing_levels",
    "bot.bot",
    "dotenv",
    "requests",
]

a = Analysis(
    [str(root / "background.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["uvicorn", "fastapi", "starlette"],
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
    name="CryptoChartsBot",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
