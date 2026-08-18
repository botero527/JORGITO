# config.py
# Aca solo leemos el .env y armamos los diccionarios de conexion por BD.
# NADA de claves hardcodeadas aca, todo sale del .env (ver .env.example).

import os
from dotenv import load_dotenv

load_dotenv()  # busca el .env en la carpeta del proyecto y carga las variables

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
}

PORT = int(os.environ.get("JORGITO_PORT", 5757))
