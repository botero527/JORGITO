# Jorgito.spec
# Receta de PyInstaller para compilar desktop.py a un solo Jorgito.exe.
# Mismo patron que PipeMirror/AGP_LAUNCHER (PanelAGP.spec) - onefile, para que
# cualquiera lo pueda copiar de la carpeta de red y correrlo sin instalar nada.
#
# Como compilar (desde esta carpeta, con el venv activo):
#   python -m PyInstaller Jorgito.spec --clean
#
# El .exe sale en dist/Jorgito.exe. El .env NO va empaquetado adentro - se
# copia a mano al lado del .exe (asi se puede rotar credenciales sin volver
# a compilar, ver README.md).

# -*- mode: python ; coding: utf-8 -*-

a = Analysis(
    ["desktop.py"],
    pathex=[],
    binaries=[],
    # templates/ y static/ tienen que ir empaquetados adentro del .exe, Flask
    # los necesita para renderizar el HTML y servir css/js - sin esto el .exe
    # abre la ventana pero se ve todo en blanco (no encuentra los archivos).
    datas=[
        ("templates", "templates"),
        ("static", "static"),
    ],
    # pymssql y pywebview importan cosas de forma dinamica segun el sistema
    # operativo - PyInstaller no siempre las detecta solo escaneando imports,
    # hay que decirselas a mano o el .exe truena al arrancar en el PC de otro.
    hiddenimports=[
        "pymssql",
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
        "webview.platforms.mshtml",
        "clr_loader",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Jorgito",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,      # sin consola negra de fondo, es una app de escritorio
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,          # pendiente: poner un .ico cuando tengamos uno
)
