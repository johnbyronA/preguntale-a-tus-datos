"""
Genera el dataset de demostración `data/ventas_demo.csv`.

Empresa ficticia: "Comercial Andina S.A.S.", un comercializador general con
ventas por varias ciudades y canales. Los datos son sintéticos pero tienen
patrones realistas para que las preguntas tengan respuestas interesantes:

- crecimiento anual (~14%) y estacionalidad (picos en noviembre y diciembre)
- diferencias de margen por categoría y de descuento por canal
- un aumento anómalo de devoluciones en E-commerce en marzo de 2026
- tiempos de entrega más largos en ciudades lejanas

Uso:
    python scripts/generate_data.py            # semilla por defecto (42)
    python scripts/generate_data.py --seed 7 --rows 30000

También escribe `tests/fixtures/schema_ventas.json`, el perfil de columnas
que usan las pruebas del motor (mismo formato que el perfilador de la app).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]

CIUDADES = {
    # ciudad: (región, peso de demanda, días base de entrega)
    "Bogotá": ("Andina", 0.30, 2),
    "Medellín": ("Andina", 0.22, 2),
    "Cali": ("Pacífico", 0.14, 3),
    "Barranquilla": ("Caribe", 0.10, 4),
    "Cartagena": ("Caribe", 0.07, 4),
    "Bucaramanga": ("Andina", 0.07, 3),
    "Pereira": ("Andina", 0.05, 3),
    "Villavicencio": ("Orinoquía", 0.05, 5),
}

CANALES = {
    # canal: (peso, descuento medio, prob. base de devolución)
    "Tienda física": (0.38, 0.04, 0.02),
    "E-commerce": (0.32, 0.08, 0.05),
    "Distribuidor": (0.18, 0.14, 0.015),
    "Televentas": (0.12, 0.06, 0.03),
}

# categoría: (margen bruto medio, productos con precio base en COP)
CATALOGO = {
    "Tecnología": (0.22, {
        "Portátil Pro 14": 2_900_000, "Monitor 27 pulgadas": 1_150_000, "Tableta 10 pulgadas": 1_250_000,
        "Audífonos inalámbricos": 320_000, "Impresora multifuncional": 780_000,
        "Disco SSD 1 TB": 390_000,
    }),
    "Hogar": (0.34, {
        "Cafetera espresso": 650_000, "Licuadora": 280_000, "Aspiradora": 540_000,
        "Juego de ollas": 410_000, "Purificador de aire": 720_000,
    }),
    "Oficina": (0.41, {
        "Resma de papel": 24_000, "Kit de escritura": 38_000, "Archivador": 165_000,
        "Calculadora financiera": 210_000, "Organizador de escritorio": 59_000,
    }),
    "Muebles": (0.29, {
        "Silla ergonómica": 890_000, "Escritorio ajustable": 1_650_000,
        "Biblioteca": 520_000, "Mesa auxiliar": 260_000,
    }),
    "Accesorios": (0.46, {
        "Mouse inalámbrico": 85_000, "Teclado mecánico": 290_000, "Base para portátil": 95_000,
        "Cable USB-C": 32_000, "Mochila para portátil": 175_000,
    }),
}
PESO_CATEGORIA = {"Tecnología": 0.27, "Hogar": 0.2, "Oficina": 0.22, "Muebles": 0.11, "Accesorios": 0.2}

VENDEDORES = [
    "Laura Gómez", "Andrés Restrepo", "Camila Ospina", "Julián Torres", "Valentina Ríos",
    "Santiago Mejía", "Daniela Cárdenas", "Mateo Vargas", "Sara Quintero", "Felipe Arango",
    "Natalia Duque", "Esteban Londoño", "Mariana Zapata", "Sebastián Henao",
]

MES_ESTACIONAL = {1: 0.82, 2: 0.86, 3: 0.95, 4: 0.93, 5: 1.0, 6: 1.04, 7: 0.97,
                  8: 0.99, 9: 1.01, 10: 1.06, 11: 1.32, 12: 1.45}


def generar(n_filas: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    inicio, fin = pd.Timestamp("2024-01-01"), pd.Timestamp("2026-09-30")
    dias = pd.date_range(inicio, fin, freq="D")

    # Peso por día: tendencia + estacionalidad mensual + efecto día de semana
    t = (dias - inicio).days.to_numpy() / 365.25
    tendencia = 1.14 ** t
    estacional = np.array([MES_ESTACIONAL[m] for m in dias.month])
    semana = np.array([1.0, 1.02, 1.03, 1.05, 1.12, 0.9, 0.55])[dias.dayofweek]
    peso_dia = tendencia * estacional * semana
    fechas = rng.choice(dias.to_numpy(), size=n_filas, p=peso_dia / peso_dia.sum())
    fechas = np.sort(fechas)

    ciudades = list(CIUDADES)
    ciudad = rng.choice(ciudades, size=n_filas, p=[CIUDADES[c][1] for c in ciudades])
    canales = list(CANALES)
    canal = rng.choice(canales, size=n_filas, p=[CANALES[c][0] for c in canales])
    cats = list(CATALOGO)
    categoria = rng.choice(cats, size=n_filas, p=[PESO_CATEGORIA[c] for c in cats])

    producto, precio_base, margen = [], [], []
    for cat in categoria:
        prods = CATALOGO[cat][1]
        nombre = rng.choice(list(prods))
        producto.append(nombre)
        precio_base.append(prods[nombre])
        margen.append(CATALOGO[cat][0])
    precio_base = np.array(precio_base, dtype=float)
    margen = np.array(margen)

    # Precio con inflación (~9% anual) y ruido
    anios = (pd.DatetimeIndex(fechas) - inicio).days.to_numpy() / 365.25
    precio_unitario = np.round(precio_base * (1.09 ** anios) * rng.normal(1, 0.04, n_filas), -2)

    # Cantidad: artículos baratos se compran en volumen; distribuidores compran más
    es_barato = precio_base < 100_000
    cantidad = rng.poisson(np.where(es_barato, 4.5, 1.2)) + 1
    cantidad = np.where(canal == "Distribuidor", cantidad * rng.integers(2, 6, n_filas), cantidad)

    desc_medio = np.array([CANALES[c][1] for c in canal])
    descuento_pct = np.clip(np.round(rng.normal(desc_medio, 0.03) * 100, 1), 0, 35)
    mes = pd.DatetimeIndex(fechas).month
    descuento_pct = np.where(mes == 11, np.clip(descuento_pct + 6, 0, 40), descuento_pct)

    ingreso = np.round(precio_unitario * cantidad * (1 - descuento_pct / 100), 0)
    costo = np.round(precio_unitario * cantidad * (1 - margen * rng.normal(1, 0.08, n_filas)), 0)

    # Estado del pedido: devoluciones más altas en E-commerce y anomalía en mar-2026
    p_dev = np.array([CANALES[c][2] for c in canal])
    fechas_idx = pd.DatetimeIndex(fechas)
    anomalia = (canal == "E-commerce") & (fechas_idx.year == 2026) & (fechas_idx.month == 3)
    p_dev = np.where(anomalia, 0.19, p_dev)
    u = rng.random(n_filas)
    estado = np.where(u < p_dev, "Devuelto", np.where(u < p_dev + 0.025, "Cancelado", "Entregado"))

    # Pedidos cancelados o devueltos no generan utilidad
    ingreso = np.where(estado == "Entregado", ingreso, 0)
    costo = np.where(estado == "Cancelado", 0, costo)
    utilidad = ingreso - costo

    dias_base = np.array([CIUDADES[c][2] for c in ciudad])
    dias_entrega = np.clip(dias_base + rng.poisson(1.3, n_filas) - (canal == "Tienda física") * dias_base, 0, 15)

    calif_media = 4.5 - 0.12 * dias_entrega - (estado == "Devuelto") * 1.6
    calificacion = np.clip(np.round(rng.normal(calif_media, 0.55)), 1, 5).astype(int)

    vendedor = rng.choice(VENDEDORES, size=n_filas,
                          p=np.linspace(1.6, 0.6, len(VENDEDORES)) / np.linspace(1.6, 0.6, len(VENDEDORES)).sum())

    df = pd.DataFrame({
        "id_pedido": [f"P-{i:06d}" for i in range(1, n_filas + 1)],
        "fecha": pd.DatetimeIndex(fechas).strftime("%Y-%m-%d"),
        "region": [CIUDADES[c][0] for c in ciudad],
        "ciudad": ciudad,
        "canal": canal,
        "categoria": categoria,
        "producto": producto,
        "vendedor": vendedor,
        "cantidad": cantidad.astype(int),
        "precio_unitario": precio_unitario.astype(int),
        "descuento_pct": descuento_pct,
        "ingreso": ingreso.astype(int),
        "costo": costo.astype(int),
        "utilidad": utilidad.astype(int),
        "estado": estado,
        "dias_entrega": dias_entrega.astype(int),
        "calificacion": calificacion,
    })
    return df


def perfil(df: pd.DataFrame, tabla: str) -> dict:
    """Perfil compatible con src/engine/schema.js (columnas, tipos y valores)."""
    cols = []
    for c in df.columns:
        s = df[c]
        if c == "fecha":
            d = pd.to_datetime(s)
            cols.append({"name": c, "type": "date", "min": str(d.min().date()), "max": str(d.max().date())})
        elif pd.api.types.is_numeric_dtype(s):
            cols.append({"name": c, "type": "number", "min": float(s.min()), "max": float(s.max()),
                         "integer": bool(pd.api.types.is_integer_dtype(s))})
        else:
            vc = s.value_counts()
            cols.append({"name": c, "type": "text", "distinct": int(s.nunique()),
                         "values": [str(v) for v in vc.index[:200]] if s.nunique() <= 200 else []})
    return {"table": tabla, "rows": int(len(df)), "columns": cols}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=24_000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    df = generar(args.rows, args.seed)
    out = ROOT / "data" / "ventas_demo.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)

    fx = ROOT / "tests" / "fixtures" / "schema_ventas.json"
    fx.parent.mkdir(parents=True, exist_ok=True)
    fx.write_text(json.dumps(perfil(df, "ventas"), ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(df):,} filas -> {out.relative_to(ROOT)}  ({out.stat().st_size/1e6:.1f} MB)")
    print(df.groupby(df['fecha'].str[:4])['ingreso'].sum().map('{:,.0f}'.format))


if __name__ == "__main__":
    main()
