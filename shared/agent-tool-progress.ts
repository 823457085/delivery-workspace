/** 工具标识用于动作标签；命令、路径及查询仍保留工具提供的原文。 */
const toolLabels: Record<string, string> = {
  run_command: '执行命令', command_status: '查看命令结果', send_command_input: '发送命令输入',
  view_file: '读取文件', read_file: '读取文件', list_dir: '浏览目录',
  grep_search: '搜索代码', find_by_name: '查找文件', write_to_file: '写入文件', write_file: '写入文件',
  replace_file_content: '修改文件', multi_replace_file_content: '修改文件',
  read_url_content: '读取网页', search_web: '搜索网页',
};
export function agentToolLabel(name: string) { return Object.hasOwn(toolLabels, name) ? toolLabels[name] : name; }

export function agentToolDescription(name: string, parameters: unknown = {}) {
  const input = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters as Record<string, unknown> : {};
  const text = (key: string) => typeof input[key] === 'string' ? input[key].trim() : '';
  const bounded = (value: string) => value.length > 210 ? `${value.slice(0, 209)}…` : value;
  if (name === 'run_command') {
    const command = text('CommandLine');
    // HTTP 客户端的任意参数都可能含正文、Cookie 或凭据；不逐个猜测参数名。
    const httpExecutable = command.match(/\b(curl|wget|httpie|https?)(?=["']?\s)/i)?.[1]
      || command.match(/^\s*["']?(?:[^\s"']*\/)?(curl|wget|httpie|https?)["']?\s*$/i)?.[1];
    if (httpExecutable) return `${agentToolLabel(name)}：${httpExecutable} [参数已隐藏]`;
    // 带请求正文、凭据或内联脚本时只显示执行器，不把参数写入公开进度和历史。
    const hidden = /[\r\n]|<<|\b(?:authorization|cookie|password|token|secret|bearer|api[_-]?key)\b|\b[A-Z][A-Z0-9_]*=|(?:^|\s)-[uU]|(?:^|\s)(?:-[a-z]*[cHep][a-z]*|--(?:data\S*|header|user|proxy-user|eval|execute|print))(?:\s|=|["'])|https?:\/\/[^\s]+(?:@|\?)/i.test(command);
    const executable = command.match(/\b(curl|wget|python\d*|node|ruby|bash|zsh|sh)\b/)?.[1]
      || command.match(/^\s*([\w./-]+)(?:\s|$)/)?.[1] || '';
    const target = hidden ? `${executable ? `${executable} ` : ''}[参数已隐藏]` : command;
    return agentToolLabel(name) + (target ? `：${bounded(target)}` : '');
  }
  if (name === 'read_url_content') {
    let target = '';
    try { const url = new URL(text('Url')); if (['https:', 'http:'].includes(url.protocol)) target = `${url.origin}${url.pathname}`; } catch { /* 无效地址不公开原始输入。 */ }
    return agentToolLabel(name) + (target ? `：${bounded(target)}` : '');
  }
  // 只取动作目标，不把文件内容、工具输出或其他参数作为公开进度。
  const target = ['CommandLine', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchDirectory', 'Query', 'Pattern', 'CommandId']
    .map(key => input[key]).find(value => typeof value === 'string' && value.trim());
  return agentToolLabel(name) + (typeof target === 'string' ? `：${bounded(target)}` : '');
}
