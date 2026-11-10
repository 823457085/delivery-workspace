#!/usr/bin/env python3
"""Update original ledger rows while preserving unrelated XLSX parts and history."""
import datetime
import html
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import sys
import tempfile
import zipfile
from xml.etree import ElementTree as ET


X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'
N = {'x': X}
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_ITEMS = 4096
MAX_XML = 16 * 1024 * 1024
MAX_ROWS = 20000
MAX_TEXT = 200000
RESULT_HEADERS = ['源工作表序号', '源工作表', '源行号', '原问题编号', '接口', '原行链接',
                  '本轮状态', '实际结果', '预期结果', '证据', '环境', '版本', '检查时间', '任务ID']
STATUS_LABELS = {'passed': '通过', 'failed': '不通过', 'blocked': '阻塞', 'not_run': '未执行'}
LABEL_STATUS = {value: key for key, value in STATUS_LABELS.items()}


class WorkbookError(Exception):
    pass


def xml(data):
    if len(data) > MAX_XML:
        raise WorkbookError('工作簿 XML 超出大小限制')
    try:
        text = data.decode('utf-8-sig')
        if re.search(r'<!\s*(?:DOCTYPE|ENTITY)', text, re.I):
            raise WorkbookError('工作簿不允许 XML 实体或文档类型声明')
        return ET.fromstring(text)
    except (UnicodeDecodeError, ET.ParseError):
        raise WorkbookError('工作簿包含无法读取的 XML') from None


def target_path(base, target):
    if not target or '\\' in target or '\x00' in target or re.match(r'^[a-z][a-z0-9+.-]*:', target, re.I):
        raise WorkbookError('工作簿关系目标不安全')
    result = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
    if result.startswith('../') or result == '..':
        raise WorkbookError('工作簿关系越出文档范围')
    return result


class Ledger:
    def __init__(self, source, catalog=False):
        self.source = Path(source)
        self.catalog = catalog
        if not self.source.is_file() or self.source.stat().st_size > MAX_ARCHIVE:
            raise WorkbookError('工作簿不存在或超过 100 MiB 限制')
        self.archive = zipfile.ZipFile(self.source)
        entries = self.archive.infolist()
        if len(entries) > MAX_ITEMS or sum(i.file_size for i in entries) > (16 * 1024 * 1024 if catalog else MAX_EXPANDED):
            raise WorkbookError('工作簿压缩包项目数或展开大小超出限制')
        seen = set()
        for item in entries:
            name = item.filename
            normalized = posixpath.normpath(name.rstrip('/'))
            if (not name or name.startswith(('/', '\\')) or '\\' in name or '\x00' in item.orig_filename
                    or re.match(r'^[A-Za-z]:', name) or '..' in name.split('/') or normalized == '.'
                    or name.rstrip('/') != normalized or normalized in seen):
                raise WorkbookError('工作簿压缩包包含危险或重复路径')
            seen.add(normalized)
            if (item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16)
                    or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise WorkbookError('工作簿不允许加密、链接或不支持的压缩项目')
            if item.file_size > 1024 * 1024 and item.file_size > max(item.compress_size, 1) * 1000:
                raise WorkbookError('工作簿压缩比超出安全限制')
            if re.search(r'(?i)(?:vbaproject|macrosheets|externallinks|activex|embeddings)', name):
                raise WorkbookError('工作簿不允许宏、外部数据链接或嵌入式程序')
        self.names = set(i.filename for i in entries)
        for name in self.names:
            if name.endswith('.rels'):
                for rel in xml(self.read(name)):
                    if rel.get('TargetMode', '').lower() == 'external' and not (catalog and rel.get('Type') == R + '/hyperlink'):
                        raise WorkbookError('工作簿包含外部关系链接，请使用本地证据附件')
        content = self.read('[Content_Types].xml')
        if b'macroenabled' in content.lower():
            raise WorkbookError('工作簿不允许启用宏')
        xml(content)
        self.book = xml(self.read('xl/workbook.xml'))
        self.relations = xml(self.read('xl/_rels/workbook.xml.rels'))
        rels = {r.get('Id'): r.get('Target') for r in self.relations}
        self.strings = []
        if 'xl/sharedStrings.xml' in self.names:
            self.strings = [''.join(t.text or '' for t in si.iter('{'+X+'}t'))
                            for si in xml(self.read('xl/sharedStrings.xml')).findall('x:si', N)]
        self.sheets = []
        for index, sheet in enumerate(self.book.findall('x:sheets/x:sheet', N)):
            if catalog and sheet.get('name') != '项目导入':
                continue
            file = target_path('xl', rels.get(sheet.get('{'+R+'}id')))
            rows = self.read_rows(xml(self.read(file)))
            self.sheets.append({'name': sheet.get('name', ''), 'index': index, 'file': file,
                                'sheetId': int(sheet.get('sheetId')), 'cells': rows})

    def read(self, name):
        try:
            return self.archive.read(name)
        except KeyError:
            raise WorkbookError('工作簿缺少必要组成文件') from None

    def read_rows(self, sheet):
        result = []
        cells_seen = 0
        for row in sheet.findall('x:sheetData/x:row', N):
            number = int(row.get('r', '0'))
            if not 1 <= number <= 1048576:
                raise WorkbookError('工作簿行号无效')
            values = {}
            for cell in row.findall('x:c', N):
                if self.catalog and cell.find('x:f', N) is not None:
                    raise WorkbookError('第 %s 行包含公式，请粘贴为值后再导入' % number)
                cells_seen += 1
                if cells_seen > 400000:
                    raise WorkbookError('工作簿单元格数量超出限制')
                address = cell.get('r', '')
                if not re.fullmatch(r'[A-Z]{1,3}[1-9]\d{0,6}', address):
                    raise WorkbookError('工作簿单元格坐标无效')
                col = re.sub(r'\d+', '', address)
                raw = cell.find('x:v', N)
                if cell.get('t') == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('x:is//x:t', N))
                elif cell.get('t') == 's' and raw is not None:
                    i = int(raw.text or '-1')
                    if not 0 <= i < len(self.strings):
                        raise WorkbookError('工作簿共享字符串索引无效')
                    value = self.strings[i]
                else:
                    value = raw.text or '' if raw is not None else ''
                if len(value) > MAX_TEXT:
                    raise WorkbookError('工作簿单元格文本超出限制')
                values[col] = value
            if any(values.values()):
                result.append((number, values))
            if self.catalog and len(result) > 201:
                raise WorkbookError('一次最多导入 200 行项目环境')
            if len(result) > MAX_ROWS:
                raise WorkbookError('工作簿有效行数超出限制')
        return result

    def close(self):
        self.archive.close()


def column_name(index):
    result = ''
    while index:
        index, digit = divmod(index - 1, 26)
        result = chr(65 + digit) + result
    return result


def column_index(name):
    index = 0
    for char in name:
        index = index * 26 + ord(char) - 64
    return index


def result_time(value):
    try:
        date = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return date.replace(tzinfo=date.tzinfo or datetime.timezone.utc).timestamp()
    except (ValueError, AttributeError, OverflowError):
        return float('-inf')


def state_for(status):
    status = status.strip()
    if re.search(r'不通过|未通过|失败|待复测', status):
        return 'pending_retest'
    if re.fullmatch(r'(?:复测|测试|联调|已)?通过', status):
        return 'passed'
    if re.search(r'暂不处理|阻塞|待处理|待修复|修复中|处理中|暂缓', status):
        return 'blocked'
    if re.search(r'待测|待测试|未测试|未执行', status):
        return 'pending_test'
    return 'unclassified'


def documented_state(source, notes):
    # The status column is the current conclusion; dated notes may describe earlier failures.
    state = state_for(source)
    if state != 'unclassified':
        return state
    # Only use explicit dated notes when the status column has no recognized conclusion.
    matches = list(re.finditer(r'(?m)(?:^|\n)[^\n]*?(20\d\d[-/]\d{1,2}[-/]\d{1,2})[^\n]*', notes))
    candidates = []
    for i, match in enumerate(matches):
        text = notes[match.start():matches[i + 1].start() if i + 1 < len(matches) else len(notes)]
        if re.search(r'未重新测试|未重新执行|未重新发起', text):
            continue
        conclusion = re.search(r'(?:复测结果|复测结论|联调结论|测试结论|结论)\s*[:：]\s*(?:复测)?(不通过|未通过|通过|失败|阻塞|未执行|待复测|待测试)', text)
        if conclusion is None:
            conclusion = re.search(r'复测\s*[:：]?\s*(不通过|通过)', text)
        if conclusion:
            try:
                date = datetime.datetime.strptime(match.group(1).replace('/', '-'), '%Y-%m-%d')
                candidates.append((date, i, state_for(conclusion.group(1))))
            except ValueError:
                pass
    return max(candidates)[2] if candidates else state_for(source)


ALIASES = {
    'issueId': ['问题编号', '问题ID', '编号', 'ID'], 'title': ['问题说明', '问题描述', '问题', '标题'],
    'sourceStatus': ['修改状态', '复测状态', '状态', '本轮状态'], 'request': ['请求接口', '接口', '接口地址'],
    'reporter': ['提出人', '提出人员', '提出人(人员)', '提出人（人员）'],
    'parameters': ['请求参数', '参数'], 'expected': ['预期 / 后端关注', '预期/后端关注', '预期结果', '预期', '本轮预期结果'],
    'actual': ['实际结果', '实际响应', '实际', '本轮实际结果'],
    'notes': ['补充 / 复测记录', '补充/复测记录', '复测记录', '备注', '本轮复测记录'],
}


def find_header(cells):
    for number, values in cells[:50]:
        mapping = {field: next((col for col, text in values.items() if text.strip() in aliases), None)
                   for field, aliases in ALIASES.items()}
        # Prefer the primary reporter column over an auxiliary personnel column.
        mapping['reporter'] = next((col for alias in ALIASES['reporter'] for col, text in values.items()
                                    if text.strip() == alias), None)
        if mapping['issueId'] and (mapping['title'] or mapping['request']):
            return number, values, mapping
    return None


def audit_results(sheet):
    cells = sheet['cells']
    if not cells or [cells[0][1].get(column_name(i + 1), '') for i in range(len(RESULT_HEADERS))] != RESULT_HEADERS:
        return None
    results = []
    for _, row in cells[1:]:
        try:
            key = (int(row.get('A', '')), int(row.get('C', '')))
            status = LABEL_STATUS.get(row.get('G', ''), row.get('G', ''))
            evidence = json.loads(row.get('J') or '[]')
            if status not in STATUS_LABELS or not isinstance(evidence, list) or not all(isinstance(e, str) for e in evidence):
                continue
            results.append((key, {'status': status, 'actual': row.get('H', ''), 'expected': row.get('I', ''),
                                  'evidence': evidence, 'environment': row.get('K', ''), 'version': row.get('L', ''),
                                  'checkedAt': row.get('M', ''), 'jobId': row.get('N', '')}))
        except (ValueError, TypeError):
            continue
    return results


def inspect(ledger):
    sheets, warnings, latest, tested = [], [], {}, set()
    for sheet in ledger.sheets:
        cells = sheet['cells']
        if not cells:
            continue
        audit = audit_results(sheet)
        if audit is not None:
            for key, result in audit:
                if result['status'] in ('passed', 'failed'):
                    tested.add(key)
                if key not in latest or result_time(result['checkedAt']) >= result_time(latest[key]['checkedAt']):
                    latest[key] = result
            continue
        header = find_header(cells)
        if not header:
            warnings.append('工作表“%s”未找到问题编号及问题/接口表头，未自动导入' % sheet['name'])
            continue
        number, headers, mapping = header
        parsed = []
        multi, unknown = 0, 0
        for row_number, values in cells:
            if row_number <= number:
                continue
            row = {field: values.get(col, '') if col else '' for field, col in mapping.items()}
            if not row['issueId'].strip() or not (row['title'].strip() or row['request'].strip()):
                continue
            endpoints = re.findall(r'\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?:https?://[^/\s]+)?(/[^\s?\n\r,，；;）)]+)', row['request'], re.I)
            methods = {method.upper() for method, _ in endpoints}
            method = endpoints[0][0].upper() if len(endpoints) == 1 else 'GET' if methods == {'GET'} else ''
            path = endpoints[0][1] if endpoints else ''
            if len(endpoints) > 1:
                multi += 1
            if not method or not path:
                unknown += 1
            row.update({'row': row_number, 'method': method, 'path': path,
                        'state': documented_state(row['sourceStatus'], row['notes'])})
            parsed.append(row)
        sheets.append({'name': sheet['name'], 'index': sheet['index'],
                       'headers': [headers.get(column_name(i), '') for i in range(1, max(column_index(c) for c in headers) + 1)], 'rows': parsed})
        if multi:
            warnings.append('工作表“%s”有 %d 条问题包含多个接口；必须核对原行全部接口，不能以单个请求代表整行通过' % (sheet['name'], multi))
        if unknown:
            warnings.append('工作表“%s”有 %d 条问题的请求方法不明确或混有写方法，需确认后才能自动执行' % (sheet['name'], unknown))
    for sheet in sheets:
        for row in sheet['rows']:
            result = latest.get((sheet['index'], row['row']))
            if result:
                row['latest'] = result
                if result['status'] == 'not_run' and not result['checkedAt'] and not result['jobId']:
                    continue  # An exported placeholder is not a new outcome and cannot reopen a passed row.
                row['state'] = {'passed': 'passed', 'failed': 'pending_retest', 'blocked': 'blocked',
                                'not_run': 'pending_retest' if row['state'] in ('passed', 'pending_retest') or (sheet['index'], row['row']) in tested else 'pending_test'}[result['status']]
    if sheets:
        warnings.append('文档中的通过状态属于历史记录；导入不会产生本轮执行或验收通过证据')
    return {'sheets': sheets, 'imageCount': sum(1 for name in ledger.names if name.startswith('xl/media/') and not name.endswith('/')), 'warnings': warnings}


def checked_text(value, field, optional=False):
    if value is None and optional:
        return ''
    if not isinstance(value, str) or len(value) > 32767 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value):
        raise WorkbookError('联调结果字段 %s 格式无效或超出限制' % field)
    return value


def append_xml(original, closing_tag, child):
    text = original.decode('utf-8-sig')
    pattern = r'</(?:[A-Za-z_][\w.-]*:)?' + closing_tag + r'\s*>'
    match = re.search(pattern, text)
    if not match:
        raise WorkbookError('工作簿组成文件缺少结束标签')
    return (text[:match.start()] + child + text[match.start():]).encode('utf-8')


XML_PREFIX = r'(?:[A-Za-z_][\w.-]*:)?'
ROW_XML = re.compile(r'<(?P<tag>' + XML_PREFIX + r'row)\b[^>]*(?:/\s*>|>.*?</(?P=tag)\s*>)', re.S)
CELL_XML = re.compile(r'<(?P<tag>' + XML_PREFIX + r'c)\b[^>]*(?:/\s*>|>.*?</(?P=tag)\s*>)', re.S)


def attribute(tag, name):
    found = re.search(r'\s' + name + r'\s*=\s*([\'"])(.*?)\1', tag.split('>', 1)[0], re.S)
    return html.unescape(found.group(2)) if found else None


def inline_cell(address, value, prefix, original=None):
    if original:
        opening = original.split('>', 1)[0].rstrip().removesuffix('/').rstrip()
        tag = re.match(r'<([^\s/>]+)', opening).group(1)
        prefix = tag[:-1]  # Keep the original namespace prefix and style/metadata attributes.
        opening = re.sub(r'\s+t\s*=\s*([\'"]).*?\1', '', opening, flags=re.S)
    else:
        tag = prefix + 'c'
        opening = '<%s r="%s"' % (tag, address)
    return '%s t="inlineStr"><%sis><%st xml:space="preserve">%s</%st></%sis></%s>' % (
        opening, prefix, prefix, html.escape(value, quote=False).replace('\r', '&#13;'), prefix, prefix, tag)


def update_row(original, changes):
    tag = re.match(r'<([^\s/>]+)', original).group(1)
    prefix = tag[:-3]
    opening_end = original.index('>') + 1
    if original[:opening_end].rstrip().endswith('/>'):
        original = original[:opening_end].rstrip()[:-2] + '></%s>' % tag
        opening_end = original.index('>') + 1
    closing = original.rfind('</')
    pending = dict(changes)
    chunks, cursor, seen = [], 0, set()
    for match in CELL_XML.finditer(original, opening_end, closing):
        address = attribute(match.group(0), 'r')
        if not address or address in seen:
            raise WorkbookError('源行包含重复或缺失的单元格坐标')
        seen.add(address)
        col = re.sub(r'\d+', '', address)
        chunks.append(original[cursor:match.start()])
        for added in sorted(list(pending), key=lambda cell: column_index(re.sub(r'\d+', '', cell))):
            if column_index(re.sub(r'\d+', '', added)) < column_index(col):
                chunks.append(inline_cell(added, pending.pop(added), prefix))
        chunks.append(inline_cell(address, pending.pop(address), prefix, match.group(0))
                      if address in pending else match.group(0))
        cursor = match.end()
    chunks.append(original[cursor:closing])
    chunks.extend(inline_cell(address, value, prefix) for address, value in sorted(
        pending.items(), key=lambda item: column_index(re.sub(r'\d+', '', item[0]))))
    chunks.append(original[closing:])
    return ''.join(chunks)


def update_sheet(original, row_changes, last_column=None):
    text = original.decode('utf-8')
    found = set()

    def replace(match):
        number = attribute(match.group(0), 'r')
        if number is None or int(number) not in row_changes:
            return match.group(0)
        number = int(number)
        if number in found:
            raise WorkbookError('源工作表包含重复的问题行')
        found.add(number)
        return update_row(match.group(0), row_changes[number])

    text = ROW_XML.sub(replace, text)
    if found != set(row_changes):
        raise WorkbookError('结果无法定位到唯一的源工作表行')
    if last_column:
        # Dimension is only a hint, but keep it large enough to include appended columns.
        root = xml(text.encode('utf-8'))
        cells = root.findall('x:sheetData/x:row/x:c', N)
        max_row = max(int(re.sub(r'[A-Z]+', '', cell.get('r'))) for cell in cells)
        last_column = max([last_column] + [column_index(re.sub(r'\d+', '', cell.get('r'))) for cell in cells])
        dimension = re.compile(r'<' + XML_PREFIX + r'dimension\b[^>]*(?:/\s*>|>\s*</' + XML_PREFIX + r'dimension\s*>)')
        text = dimension.sub(lambda match: re.sub(r'\bref\s*=\s*([\'"]).*?\1',
                             'ref="A1:%s%d"' % (column_name(last_column), max_row), match.group(0)), text, count=1)
    xml(text.encode('utf-8'))
    return text.encode('utf-8')


def result_key(location, result):
    return json.dumps([location, {key: result.get(key, '' if key != 'evidence' else []) for key in
                                 ('status', 'actual', 'expected', 'evidence', 'environment', 'version', 'checkedAt', 'jobId')}],
                      ensure_ascii=False, sort_keys=True)


def update_source_sheets(ledger, source_rows, results):
    changes, added_columns = {}, {}
    layouts = {}
    updated_count = 0
    labels = {'passed': '复测通过', 'failed': '复测不通过', 'blocked': '暂缓/阻塞', 'not_run': '未执行'}
    added_headers = {'sourceStatus': '本轮状态', 'actual': '本轮实际结果',
                     'expected': '本轮预期结果', 'notes': '本轮复测记录'}
    for result in results:
        if result['status'] == 'not_run' and not result['checkedAt'] and not result['jobId']:
            continue
        location = (result['sheet'], result['row'])
        _, source = source_rows[location]
        latest = source.get('latest')
        if latest and result_time(latest['checkedAt']) > result_time(result['checkedAt']):
            continue  # A late-arriving older report must not roll back the current row.
        fields = {'sourceStatus': labels[result['status']], 'actual': result['actual']}
        if result['status'] == 'not_run' and source['state'] in ('passed', 'pending_retest'):
            fields['sourceStatus'] = '未执行（待复测）'
        if result['hasExpected']:
            fields['expected'] = result['expected']
        if latest and result_key(location, latest) == result_key(location, result) and all(
                source[field] == value for field, value in fields.items()):
            continue
        sheet = ledger.sheets[result['sheet']]
        if sheet['index'] not in layouts:
            header_row, headers, mapping = find_header(sheet['cells'])
            # Include cells below the header, so trailing comments or formulas are never overwritten.
            original_cells = xml(ledger.read(sheet['file'])).findall('x:sheetData/x:row/x:c', N)
            max_col = max(column_index(re.sub(r'\d+', '', cell.get('r'))) for cell in original_cells)
            layouts[sheet['index']] = [header_row, dict(headers), dict(mapping), max_col]
        layout = layouts[sheet['index']]
        header_row, headers, mapping, max_col = layout
        sheet_changes = changes.setdefault(sheet['file'], {})
        for field in [*fields, 'notes']:
            if mapping[field] is None:
                max_col += 1
                if max_col > 16384:
                    raise WorkbookError('原工作表没有可追加的结果列')
                col = column_name(max_col)
                mapping[field] = col
                headers[col] = added_headers[field]
                sheet_changes.setdefault(header_row, {})[col + str(header_row)] = added_headers[field]
                added_columns[sheet['file']] = max_col
        layout[3] = max_col
        history = ['%s 本轮联调结果（任务 %s）' % (result['checkedAt'], result['jobId']),
                   '状态：' + fields['sourceStatus'], '实际结果：' + result['actual']]
        if result['hasExpected']:
            history.append('预期结果：' + result['expected'])
        history += ['环境：' + result['environment'], '版本：' + result['version'],
                    '证据：' + json.dumps(result['evidence'], ensure_ascii=False), '更新前原表记录：']
        for field in fields:
            history.extend(['原%s：' % headers[mapping[field]], source[field]])
        history.extend(['原补充 / 复测记录（完整保留）：', source['notes']])
        fields['notes'] = checked_text('\n'.join(history), '复测历史记录')
        sheet_changes[result['row']] = {mapping[field] + str(result['row']): value for field, value in fields.items()}
        updated_count += 1
    return {file: update_sheet(ledger.read(file), rows, added_columns.get(file)) for file, rows in changes.items()}, updated_count


def export(ledger, destination, results_file):
    destination = Path(destination)
    if destination.resolve() == ledger.source.resolve() or destination.exists():
        raise WorkbookError('导出必须使用新的文件路径，不能覆盖原件或已有文件')
    results_path = Path(results_file)
    if results_path.stat().st_size > MAX_XML:
        raise WorkbookError('联调结果文件超出限制')
    results = json.loads(results_path.read_text('utf-8'))
    if not isinstance(results, list) or len(results) > MAX_ROWS:
        raise WorkbookError('联调结果必须是受限数组')
    data = inspect(ledger)
    source_rows = {(sheet['index'], row['row']): (sheet, row) for sheet in data['sheets'] for row in sheet['rows']}
    output_rows = [RESULT_HEADERS]
    normalized, seen = [], set()
    existing = {result_key(location, result) for sheet in ledger.sheets
                for location, result in (audit_results(sheet) or [])}
    audit_locations = []
    for result in results:
        if not isinstance(result, dict) or type(result.get('sheet')) is not int or type(result.get('row')) is not int:
            raise WorkbookError('联调结果必须包含明确的源工作表序号和行号')
        location = (result['sheet'], result['row'])
        if location not in source_rows or result.get('status') not in STATUS_LABELS:
            raise WorkbookError('联调结果指向不存在的问题行或结论无效')
        if location in seen:
            raise WorkbookError('联调结果重复指向同一源问题行')
        seen.add(location)
        evidence = result.get('evidence')
        if not isinstance(evidence, list) or len(evidence) > 100 or not all(isinstance(e, str) and len(e) <= MAX_TEXT for e in evidence):
            raise WorkbookError('联调结果证据列表格式无效')
        fields = {key: checked_text(result.get(key), key, optional=key == 'expected')
                  for key in ('actual', 'expected', 'environment', 'version', 'checkedAt', 'jobId')}
        real_result = result['status'] != 'not_run' or fields['checkedAt'] or fields['jobId']
        if real_result and result_time(fields['checkedAt']) == float('-inf'):
            raise WorkbookError('联调结果检查时间必须是有效 ISO 时间')
        if real_result and not fields['jobId'].strip():
            raise WorkbookError('已执行联调结果必须包含任务ID')
        normalized_result = {**result, **fields, 'hasExpected': result.get('expected') is not None}
        normalized.append(normalized_result)
        if result_key(location, normalized_result) in existing:
            continue
        sheet, source = source_rows[location]
        link = "#'%s'!A%d" % (sheet['name'].replace("'", "''"), result['row'])
        output_rows.append([str(result['sheet']), sheet['name'], str(result['row']), source['issueId'], source['request'], link,
                            STATUS_LABELS[result['status']], fields['actual'], fields['expected'], json.dumps(evidence, ensure_ascii=False),
                            fields['environment'], fields['version'], fields['checkedAt'], fields['jobId']])
        audit_locations.append(location)
    source_updates, updated_count = update_source_sheets(ledger, source_rows, normalized)
    has_audit_sheet = any(audit_results(sheet) is not None for sheet in ledger.sheets)
    add_audit = len(output_rows) > 1 or not results and not has_audit_sheet
    if not results and add_audit:
        output_rows.append(['', '', '', '', '', '', '未执行', '尚无本轮执行结果；原文档状态及历史证据保持原样', '', '[]', '', '', '', ''])
    names = {s['name'] for s in ledger.sheets}
    name, suffix = '本轮联调结果', 2
    while name in names:
        name = '本轮联调结果 (%d)' % suffix
        suffix += 1
    n = 1
    while 'xl/worksheets/sheet%d.xml' % n in ledger.names:
        n += 1
    worksheet_file = 'xl/worksheets/sheet%d.xml' % n
    sheet_id = max([s['sheetId'] for s in ledger.sheets] + [0]) + 1
    rids = {r.get('Id') for r in ledger.relations}
    rid = 'rIdRefactor%d' % sheet_id
    while rid in rids:
        rid += '_'
    new_sheet = ET.Element('worksheet', {'xmlns': X})
    ET.SubElement(new_sheet, 'dimension', {'ref': 'A1:N%d' % len(output_rows)})
    views = ET.SubElement(new_sheet, 'sheetViews')
    view = ET.SubElement(views, 'sheetView', {'workbookViewId': '0'})
    ET.SubElement(view, 'pane', {'ySplit': '1', 'topLeftCell': 'A2', 'activePane': 'bottomLeft', 'state': 'frozen'})
    cols = ET.SubElement(new_sheet, 'cols')
    for i, width in enumerate([16, 24, 12, 36, 60, 36, 14, 70, 60, 70, 30, 30, 28, 40], 1):
        ET.SubElement(cols, 'col', {'min': str(i), 'max': str(i), 'width': str(width), 'customWidth': '1'})
    sheet_data = ET.SubElement(new_sheet, 'sheetData')
    for i, values in enumerate(output_rows, 1):
        row = ET.SubElement(sheet_data, 'row', {'r': str(i)})
        for j, value in enumerate(values, 1):
            checked_text(value, RESULT_HEADERS[j - 1])
            cell = ET.SubElement(row, 'c', {'r': column_name(j) + str(i), 't': 'inlineStr'})
            text = ET.SubElement(ET.SubElement(cell, 'is'), 't', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
            text.text = value
    if audit_locations:
        links = ET.SubElement(new_sheet, 'hyperlinks')
        for i, source_location in enumerate(audit_locations, 2):
            sheet, _ = source_rows[source_location]
            location = "'%s'!A%d" % (sheet['name'].replace("'", "''"), source_location[1])
            ET.SubElement(links, 'hyperlink', {'ref': 'F%d' % i, 'location': location, 'display': output_rows[i - 1][5]})
    workbook_xml = ledger.read('xl/workbook.xml')
    closing = re.search(r'</([A-Za-z_][\w.-]*:)?sheets\s*>', workbook_xml.decode('utf-8-sig'))
    prefix = closing.group(1) or '' if closing else ''
    sheet_tag = '<%ssheet xmlns:r="%s" name="%s" sheetId="%d" r:id="%s"/>' % (prefix, R, html.escape(name, quote=True), sheet_id, rid)
    updates = {**source_updates, **({
        'xl/workbook.xml': append_xml(workbook_xml, 'sheets', sheet_tag),
        'xl/_rels/workbook.xml.rels': append_xml(ledger.read('xl/_rels/workbook.xml.rels'), 'Relationships', '<Relationship xmlns="%s" Id="%s" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>' % (P, rid, R, n)),
        '[Content_Types].xml': append_xml(ledger.read('[Content_Types].xml'), 'Types', '<Override xmlns="%s" PartName="/%s" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (C, worksheet_file)),
    } if add_audit else {})}
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.refactor-workbook-', suffix='.xlsx', dir=destination.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for item in ledger.archive.infolist():
                archive.writestr(item, updates.get(item.filename, ledger.read(item.filename)))
            if add_audit:
                archive.writestr(worksheet_file, ET.tostring(new_sheet, encoding='utf-8', xml_declaration=True).replace(b'\r', b'&#13;'))
        # Exclusive creation prevents a racing writer from replacing an existing document.
        os.link(temporary, destination)
    finally:
        os.unlink(temporary)
    return {'output': str(destination), 'resultSheet': name if add_audit else '', 'resultCount': len(results),
            'sourceRowsPreserved': True, 'updatedRowCount': updated_count, 'imageCount': data['imageCount']}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'catalog':
        ledger = Ledger(sys.argv[2], catalog=True)
        try:
            if len(ledger.sheets) != 1:
                raise WorkbookError('请使用模板中的「项目导入」工作表')
            return ledger.sheets[0]['cells']
        finally:
            ledger.close()
    if len(sys.argv) not in (3, 5) or sys.argv[1] not in ('inspect', 'export'):
        raise WorkbookError('用法：refactor-workbook.py inspect INPUT 或 export INPUT OUTPUT RESULTS_JSON')
    if sys.argv[1] == 'inspect' and len(sys.argv) != 3 or sys.argv[1] == 'export' and len(sys.argv) != 5:
        raise WorkbookError('工作簿命令参数不正确')
    ledger = Ledger(sys.argv[2])
    try:
        return inspect(ledger) if sys.argv[1] == 'inspect' else export(ledger, sys.argv[3], sys.argv[4])
    finally:
        ledger.close()


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except WorkbookError as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, OverflowError):
        print(json.dumps({'error': '工作簿读取或导出失败，请检查文档格式与本机文件权限'}, ensure_ascii=False))
        sys.exit(1)
