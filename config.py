# config.py
# Aca solo leemos el .env y armamos los diccionarios de conexion por BD.
# NADA de claves hardcodeadas aca, todo sale del .env (ver .env.example).

import os
import sys
from dotenv import load_dotenv

# OJO con esto - nos comimos un bug real en otra PC por confiarnos de
# load_dotenv() a secas: esa funcion busca el .env a partir del directorio
# de trabajo ACTUAL del proceso (cwd), no de donde vive el .exe. En la PC de
# desarrollo el cwd coincidia por casualidad con la carpeta del exe, pero en
# otra PC no coincidio y el .env nunca se encontro -> KeyError en cada
# os.environ[...] de aca abajo. La forma correcta es calcular la carpeta
# REAL del ejecutable (o del script si no esta compilado) y apuntar ahi.
if getattr(sys, "frozen", False):
    # corriendo como .exe compilado con PyInstaller: sys.executable es la
    # ruta del Jorgito.exe en si, el .env vive al lado de ese archivo.
    _carpeta_base = os.path.dirname(sys.executable)
else:
    # corriendo como script normal (python app.py mientras desarrollamos)
    _carpeta_base = os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(_carpeta_base, ".env"))

BDS = {
    "genesis": {
        "server": os.environ["GENESIS_SERVER"],
        "database": os.environ["GENESIS_DB"],
        "user": os.environ["GENESIS_USER"],
        "password": os.environ["GENESIS_PWD"],
    },
    "sap": {
        "server": os.environ["SAP_SERVER"],
        "database": os.environ["SAP_DB"],
        "user": os.environ["SAP_USER"],
        "password": os.environ["SAP_PWD"],
    },
    "productivity": {
        "server": os.environ["PRODUCTIVITY_SERVER"],
        "database": os.environ["PRODUCTIVITY_DB"],
        "user": os.environ["PRODUCTIVITY_USER"],
        "password": os.environ["PRODUCTIVITY_PWD"],
    },
    # OJO esta si es de lectura Y escritura, a diferencia de las otras 3.
    # Aca vive el esquema JORGITO con los comentarios de comparacion de planos.
    "ingenieria": {
        "server": os.environ["INGENIERIA_SERVER"],
        "database": os.environ["INGENIERIA_DB"],
        "user": os.environ["INGENIERIA_USER"],
        "password": os.environ["INGENIERIA_PWD"],
    },
}

PORT = int(os.environ.get("JORGITO_PORT", 5757))
