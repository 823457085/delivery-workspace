"""Convert a user-provided interface worksheet into the local review inventory."""

import json
import re
import argparse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


NAMESPACE = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def clean(value):
    return " ".join(str(value or "").split())


def main(source, target, contract, sheet=3, first_row=4):
    with zipfile.ZipFile(source) as workbook:
        strings = ["".join(node.itertext()) for node in ET.fromstring(workbook.read("xl/sharedStrings.xml")).findall("x:si", NAMESPACE)]
        sheet = ET.fromstring(workbook.read(f"xl/worksheets/sheet{sheet}.xml"))
        rows = {}
        for row in sheet.findall(".//x:sheetData/x:row", NAMESPACE):
            values = {}
            for cell in row.findall("x:c", NAMESPACE):
                raw = cell.find("x:v", NAMESPACE)
                value = raw.text if raw is not None else ""
                if cell.get("t") == "s" and value:
                    value = strings[int(value)]
                if value:
                    values[re.match(r"[A-Z]+", cell.get("r")).group()] = clean(value)
            rows[int(row.get("r"))] = values
        for merged in sheet.findall(".//x:mergeCells/x:mergeCell", NAMESPACE):
            start, end = merged.get("ref").split(":")
            first_col, first_row = re.fullmatch(r"([A-Z]+)(\d+)", start).groups()
            last_col, last_row = re.fullmatch(r"([A-Z]+)(\d+)", end).groups()
            if first_col == last_col and first_col in rows[int(first_row)]:
                for number in range(int(first_row) + 1, int(last_row) + 1):
                    rows[number][first_col] = rows[int(first_row)][first_col]

    snapshot = json.loads(Path(contract).read_text())
    operations = {operation["path"]: operation for stage in snapshot["stages"] for operation in stage["operations"]}
    inventory = []
    for number, values in rows.items():
        if number < first_row or not values.get("G"):
            continue
        match = operations.get(values["G"])
        inventory.append({
            "id": f"apex-bff-{number}",
            "sourceRow": number,
            "module": values["A"],
            "pageModule": values.get("C") or "工作簿未填写",
            "platform": values.get("D", ""),
            "priority": values.get("E", ""),
            "name": values["F"],
            "path": values["G"],
            "planNote": values.get("B", ""),
            "completion": values.get("L", ""),
            "remark": values.get("M", ""),
            "contract": {"method": match["method"], "status": match["contractStatus"], "operationId": match["operationId"]} if match else None,
        })
    if not inventory or len({item["path"] for item in inventory}) != len(inventory):
        raise ValueError("工作簿必须包含接口且路径唯一")
    Path(target).write_text(json.dumps({"source": Path(source).name, "sourceSheet": "用户接口工作表", "contractSnapshot": Path(contract).name, "items": inventory}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("target")
    parser.add_argument("contract")
    parser.add_argument("--sheet", type=int, default=3, help="worksheet number")
    parser.add_argument("--first-row", type=int, default=4)
    args = parser.parse_args()
    main(args.source, args.target, args.contract, args.sheet, args.first_row)
